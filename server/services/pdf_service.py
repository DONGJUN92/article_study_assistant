"""PDF parsing service using PyMuPDF."""
from __future__ import annotations

import base64
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

import fitz
from langdetect import detect

import nltk
from nltk.tokenize import sent_tokenize

try:
    nltk.data.find('tokenizers/punkt_tab')
except LookupError:
    nltk.download('punkt_tab', quiet=True)
try:
    nltk.data.find('tokenizers/punkt')
except LookupError:
    nltk.download('punkt', quiet=True)

from config import DOCUMENTS_DIR, CHUNK_SIZE, CHUNK_OVERLAP


class PDFService:
    """Extract and chunk text from PDF documents."""

    @staticmethod
    def generate_doc_id(content: bytes) -> str:
        return hashlib.sha256(content).hexdigest()[:16]

    @staticmethod
    def clean_pdf_text(text: str) -> str:
        blocks = text.split("\n\n")
        cleaned_blocks = []
        for block in blocks:
            # remove hyphens at line ends
            b = re.sub(r'-\n\s*', '', block)
            # replace remaining single newlines with space
            b = b.replace('\n', ' ')
            # remove multi-spaces
            b = re.sub(r'[ \t]+', ' ', b)
            cleaned_blocks.append(b.strip())
        return "\n\n".join(b for b in cleaned_blocks if b)

    def _extract_words_smart_layout(self, page_width: float, words: List[dict]) -> List[dict]:
        """
        Extract words applying a smart gutter layout heuristic and PyMuPDF block/line numbers.
        Now uses Vertical Projection Profile for dynamic column gutter detection.
        """
        if not words:
            return []
            
        import statistics

        # 1. Vertical Projection Profile for dynamic gutters
        # We divide width into 200 bins
        bins = 200
        bin_width = page_width / bins
        profile = [0] * bins
        
        for w in words:
            # Add to bins
            sb = int(w['x0'] / bin_width)
            eb = int(w['x1'] / bin_width)
            for b in range(max(0, sb), min(bins, eb + 1)):
                profile[b] += 1
                
        # Find the widest empty gap in the middle 40% of the page
        # which usually represents the center gutter of a 2-column layout.
        start_search = int(bins * 0.30)
        end_search = int(bins * 0.70)
        
        max_gap_len = 0
        max_gap_center = page_width / 2.0
        
        current_gap_len = 0
        current_gap_start = 0
        
        for i in range(start_search, end_search):
            # A threshold of 1 or 2 handles slight overlaps
            if profile[i] <= 2:
                if current_gap_len == 0:
                    current_gap_start = i
                current_gap_len += 1
            else:
                if current_gap_len > max_gap_len:
                    max_gap_len = current_gap_len
                    max_gap_center = ((current_gap_start + i) / 2.0) * bin_width
                current_gap_len = 0
                
        if current_gap_len > max_gap_len:
            max_gap_center = ((current_gap_start + end_search) / 2.0) * bin_width
            
        # The center axis is definitively found
        center_x = max_gap_center
        gutter_margin = page_width * 0.015

        # Group words by PyMuPDF block numbers to prevent hidden layers/watermarks from interleaving
        blocks_dict = {}
        for w in words:
            blocks_dict.setdefault(w.get('block_n', 0), []).append(w)
            
        final_words = []
        
        for b_num in sorted(blocks_dict.keys()):
            b_words = blocks_dict[b_num]
            
            # Group into lines purely by fitz native line_n
            line_dict = {}
            for w in b_words:
                line_dict.setdefault(w.get('line_n', 0), []).append(w)
                
            lines = []
            for l_num in sorted(line_dict.keys()):
                # Sort words within the visual line natively by PyMuPDF's word sequence number
                line_words = line_dict[l_num]
                line_words.sort(key=lambda w: w.get('word_n', 0))
                lines.append(line_words)

            typed_lines = []
            for line in lines:
                min_x = min(w['x0'] for w in line)
                max_x = max(w['x1'] for w in line)

                w_type = 'split'
                if min_x < (center_x - gutter_margin) and max_x > (center_x + gutter_margin):
                    has_spanning = False
                    for w in line:
                        if w['x0'] < (center_x - gutter_margin) and w['x1'] > (center_x + gutter_margin):
                            has_spanning = True
                            break
                    w_type = 'spanning' if has_spanning else 'split'

                typed_lines.append({'type': w_type, 'words': line})

            sub_blocks = []
            if not typed_lines:
                continue
            current_sub = {'type': typed_lines[0]['type'], 'lines': [typed_lines[0]['words']]}
            for t_line in typed_lines[1:]:
                if t_line['type'] == current_sub['type']:
                    current_sub['lines'].append(t_line['words'])
                else:
                    sub_blocks.append(current_sub)
                    current_sub = {'type': t_line['type'], 'lines': [t_line['words']]}
            sub_blocks.append(current_sub)

            for sb in sub_blocks:
                if sb['type'] == 'spanning':
                    sb_words = [w for line in sb['lines'] for w in line]
                    # Sort primarily by sequential line number, then by word sequence
                    sb_words.sort(key=lambda w: (w.get('line_n', 0), w.get('word_n', 0)))
                    final_words.extend(sb_words)
                else:
                    left_words = []
                    right_words = []
                    for line in sb['lines']:
                        for w in line:
                            mid_x = (w['x0'] + w['x1']) / 2.0
                            if mid_x < center_x:
                                left_words.append(w)
                            else:
                                right_words.append(w)
                    left_words.sort(key=lambda w: (w.get('line_n', 0), w.get('word_n', 0)))
                    right_words.sort(key=lambda w: (w.get('line_n', 0), w.get('word_n', 0)))
                    final_words.extend(left_words)
                    final_words.extend(right_words)
                    
        return final_words

    def extract_from_url(self, url: str) -> dict:
        """Download & extract text from a PDF URL (file:// or http(s)://)."""
        import httpx
        resp = httpx.get(url, follow_redirects=True, timeout=60)
        resp.raise_for_status()
        return self.extract_from_bytes(resp.content, filename=url.split("/")[-1])

    def extract_from_base64(self, b64_data: str, filename: str = "document.pdf") -> dict:
        raw = base64.b64decode(b64_data)
        return self.extract_from_bytes(raw, filename)

    def extract_from_bytes(self, raw: bytes, filename: str = "document.pdf") -> dict:
        doc_id = self.generate_doc_id(raw)
        doc_dir = DOCUMENTS_DIR / doc_id
        doc_dir.mkdir(parents=True, exist_ok=True)

        pdf_path = doc_dir / filename
        pdf_path.write_bytes(raw)

        pages: List[dict] = []
        full_text_parts: List[str] = []
        sentence_map = []
        
        # Initial title from filename
        title = filename
        if title.lower().endswith(".pdf"):
            title = title[:-4]

        try:
            doc = fitz.open(stream=raw, filetype="pdf")
            page_count = len(doc)
            pdf_metadata = doc.metadata or {}
            
            if pdf_metadata.get("title"):
                raw_title = str(pdf_metadata.get("title", "")).strip(" ()'")
                if len(raw_title) > 5:
                    title = raw_title
                    
            for i in range(page_count):
                page_num = i + 1
                page = doc[i]
                
                # Fetch image rects for masking
                mask_rects = []
                image_info = page.get_image_info()
                for img in image_info:
                    mask_rects.append(fitz.Rect(img["bbox"]))
                    
                page_height = float(page.rect.height)
                margin_top = page_height * 0.08
                margin_bottom = page_height * 0.92
                
                # PyMuPDF text extraction
                fitz_words = page.get_text("words")
                words = []
                for w in fitz_words:
                    word_dict = {
                        'x0': w[0],
                        'top': w[1],
                        'x1': w[2],
                        'bottom': w[3],
                        'text': w[4],
                        'block_n': w[5],
                        'line_n': w[6],
                        'word_n': w[7]
                    }
                    
                    # 1) Margin filtering (top/bottom 8%)
                    mid_y = (word_dict['top'] + word_dict['bottom']) / 2.0
                    if mid_y < margin_top or mid_y > margin_bottom:
                        continue
                        
                    # 2) Image Masking
                    w_rect = fitz.Rect(word_dict['x0'], word_dict['top'], word_dict['x1'], word_dict['bottom'])
                    is_masked = False
                    for mr in mask_rects:
                        if w_rect.intersects(mr):
                            is_masked = True
                            break
                    if is_masked:
                        continue
                        
                    words.append(word_dict)
                
                if not words:
                    continue
                
                page_width = float(page.rect.width)
                sorted_words = self._extract_words_smart_layout(page_width, words)
                
                page_text = " ".join([w["text"] for w in sorted_words])
                pages.append({
                    "page": page_num,
                    "text": page_text
                })
                full_text_parts.append(page_text)
                
                page_text_clean = re.sub(r'\s+', ' ', page_text).strip()
                
                try:
                    tokenizer = nltk.data.load('tokenizers/punkt/english.pickle')
                except LookupError:
                    tokenizer = nltk.data.load('tokenizers/punkt_tab/english.pickle')
                
                tokenizer._params.abbrev_types.update(['al', 'e.g', 'i.e', 'fig', 'eq', 'vol', 'no', 'vs', 'cf'])
                
                sentences = tokenizer.tokenize(page_text_clean)
                
                merged_sents = []
                for s in sentences:
                    if merged_sents and re.match(r'^[a-z\(\[\,\;\:]', s.strip()):
                        merged_sents[-1] = merged_sents[-1] + " " + s
                    else:
                        merged_sents.append(s)
                sentences = merged_sents
                
                if not sentences and page_text_clean:
                    sentences = [page_text_clean]
                    
                import difflib
                
                word_texts = [w["text"] for w in sorted_words]
                current_word_idx = 0
                num_words = len(sorted_words)
                
                for sent in sentences:
                    sent_words = sent.split()
                    if not sent_words: 
                        continue
                        
                    window_size = len(sent_words) + 15
                    window = word_texts[current_word_idx : min(current_word_idx + window_size, num_words)]
                    
                    sm = difflib.SequenceMatcher(None, sent_words, window)
                    match = sm.find_longest_match(0, len(sent_words), 0, len(window))
                    
                    matched_end = current_word_idx + match.b + match.size
                    
                    # Fallback to length-based matching if fuzzy match is poor
                    if match.size == 0 or match.size < len(sent_words) * 0.3:
                        sent_clean_len = len(re.sub(r'\s+', '', sent))
                        consumed = ""
                        matched_end = current_word_idx
                        while matched_end < num_words and len(consumed) < sent_clean_len:
                            consumed += re.sub(r'\s+', '', sorted_words[matched_end]["text"])
                            matched_end += 1
                            
                    rects = []
                    for w_idx in range(current_word_idx, matched_end):
                        if w_idx < num_words:
                            w = sorted_words[w_idx]
                            rects.append([w["x0"], w["top"], w["x1"], w["bottom"]])
                            
                    sentence_map.append({
                        "page": page_num,
                        "text": sent,
                        "rects": rects
                    })
                    
                    current_word_idx = matched_end
                    
            doc.close()

        except Exception as e:
            print(f"Extraction error: {e}")
            pass

        full_text = "\n\n".join(full_text_parts)

        # Detect language
        lang = "en"
        try:
            if full_text:
                sample = full_text[:3000]
                lang = detect(sample)
        except Exception:
            pass

        # Use textual title fallback if metadata failed
        if len(title) < 5 or "document.pdf" in title:
            for line in full_text.split("\n"):
                stripped = line.strip()
                if stripped and len(stripped) > 5:
                    title = stripped[:120]
                    break

        # Chunk text
        chunks = self._chunk_text(pages)

        metadata = {
            "doc_id": doc_id,
            "filename": filename,
            "title": title,
            "page_count": page_count,
            "language": lang,
            "ingested_at": datetime.now(timezone.utc).isoformat(),
            "chunk_count": len(chunks),
        }

        # Save metadata
        (doc_dir / "metadata.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        # Save full text for translation
        (doc_dir / "full_text.txt").write_text(full_text, encoding="utf-8")
        # Save pages
        (doc_dir / "pages.json").write_text(
            json.dumps(pages, ensure_ascii=False, indent=2), encoding="utf-8"
        )

        # Save sentence map
        (doc_dir / "sentences.json").write_text(
            json.dumps(sentence_map, ensure_ascii=False, indent=2), encoding="utf-8"
        )


        return {**metadata, "chunks": chunks, "full_text": full_text, "pages": pages, "sentence_map": sentence_map}

    def _chunk_text(self, pages: List[dict]) -> List[dict]:
        """Split pages into overlapping chunks."""
        chunks: List[dict] = []
        chunk_id = 0

        for page_info in pages:
            page_num = page_info["page"]
            text = page_info["text"]
            paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]

            current_chunk = ""
            for para in paragraphs:
                if len(current_chunk.split()) + len(para.split()) > CHUNK_SIZE:
                    if current_chunk:
                        chunks.append({
                            "chunk_id": chunk_id,
                            "page": page_num,
                            "text": current_chunk.strip(),
                        })
                        chunk_id += 1
                        # Overlap: keep last N words
                        words = current_chunk.split()
                        current_chunk = " ".join(words[-CHUNK_OVERLAP:]) + " " + para
                    else:
                        current_chunk = para
                else:
                    current_chunk = (current_chunk + "\n\n" + para).strip()

            if current_chunk.strip():
                chunks.append({
                    "chunk_id": chunk_id,
                    "page": page_num,
                    "text": current_chunk.strip(),
                })
                chunk_id += 1

        return chunks

    def get_document_metadata(self, doc_id: str) -> Optional[dict]:
        meta_path = DOCUMENTS_DIR / doc_id / "metadata.json"
        if meta_path.exists():
            return json.loads(meta_path.read_text(encoding="utf-8"))
        return None

    def get_document_text(self, doc_id: str) -> Optional[str]:
        text_path = DOCUMENTS_DIR / doc_id / "full_text.txt"
        if text_path.exists():
            return text_path.read_text(encoding="utf-8")
        return None

    def get_document_pages(self, doc_id: str) -> Optional[List[dict]]:
        pages_path = DOCUMENTS_DIR / doc_id / "pages.json"
        if pages_path.exists():
            return json.loads(pages_path.read_text(encoding="utf-8"))
        return None

    def get_document_sentences(self, doc_id: str) -> Optional[List[dict]]:
        sent_path = DOCUMENTS_DIR / doc_id / "sentences.json"
        if sent_path.exists():
            return json.loads(sent_path.read_text(encoding="utf-8"))
        return None

    def get_document_pdf_path(self, doc_id: str) -> Optional[Path]:
        doc_dir = DOCUMENTS_DIR / doc_id
        if doc_dir.exists():
            for f in doc_dir.iterdir():
                if f.suffix.lower() == ".pdf":
                    return f
        return None

    def list_documents(self) -> List[dict]:
        docs = []
        if DOCUMENTS_DIR.exists():
            for d in DOCUMENTS_DIR.iterdir():
                if d.is_dir():
                    meta = self.get_document_metadata(d.name)
                    if meta:
                        docs.append(meta)
        return sorted(docs, key=lambda x: x.get("ingested_at", ""), reverse=True)

    def delete_document(self, doc_id: str) -> bool:
        doc_dir = DOCUMENTS_DIR / doc_id
        if doc_dir.exists():
            import shutil
            shutil.rmtree(doc_dir)
            return True
        return False

    def update_metadata(self, doc_id: str, updates: dict) -> bool:
        doc_dir = DOCUMENTS_DIR / doc_id
        meta_path = doc_dir / "metadata.json"
        if not meta_path.exists():
            return False
        
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta.update(updates)
            meta_path.write_text(
                json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            return True
        except Exception as e:
            print(f"Update metadata error: {e}")
            return False

pdf_service = PDFService()
