# 📚 Article Study Assistant: AI 논문 학습 어시스턴트

Article Study Assistant는 연구원과 학생들을 위한 AI 기반 논문 학습 보조 도구입니다. Chromium 확장 프로그램을 통해 논문을 실시간으로 분석하고, Ollama와 FastAPI 백엔드를 사용하여 오프라인 환경에서도 문맥 기반 질문, 단어 분석, 자동 번역, 그리고 AI 기반 학습 노트를 제공합니다.

---

## 🏗️ 시스템 아키텍처

- **Frontend (Extension)**: 리얼타임 PDF 감지, 트레이 메뉴, 분할 뷰(원본 대조 번역), 사이드패널 UI.
- **Backend (FastAPI)**: 문서 인덱싱, RAG(검색 증강 생성) 채팅, OCR(이미지 PDF 텍스트 추출), 학습 노트 평가 파이프라인.
- **AI Engine (Ollama)**: 로컬에서 실행되는 `gemma4:e2b` 모델과 `nomic-embed-text` 임베딩 엔진.

---

## 🎯 주요 기능 사양

### 1. 강력한 논문 인제스트 (Ingest) & OCR
- **Smart Parsing**: PyMuPDF를 사용한 빠른 텍스트 추출 및 2단 레이아웃 자동 감지.
- **Hybrid Search**: 추출된 텍스트는 `VectorRAG` 모듈을 통해 파싱되어 효율적인 지식 검색을 지원.

### 2. 문맥 기반 AI Chat (RAG)
- **Deep Context Query**: 논문의 특정 섹션이나 단어뿐만 아니라 전체 흐름을 RAG로 인지한 상태에서 답변 제공.
- **Reflection Logic**: AI가 답변 전 스스로 내용을 검토(reflection)하여 학술적 톤을 유지하고 불필요한 인삿말을 제거함.

### 3. 지능형 학습 노트 (Notes)
- **3-Stage Pipeline**: 사용자가 작성한 노트를 AI가 (1) 점수 산정, (2) 보완 피드백, (3) 핵심 요약의 3단계로 분석.
- **Academic Tutoring**: 논문 내용과 대조하여 사용자가 놓친 핵심 포인트를 짚어주는 비동기 평가 지원.

### 4. 고도화된 번역 및 단어 분석
- **Split-View Translation**: 원본 PDF와 번역문을 1:1로 대조하여 볼 수 있는 2분할 뷰 제공.
- **Contextual Dictionary**: 논문 내 문맥에서의 실제 뜻, 학술적 정의, 유의어, 반의어를 분석.

---

## 📁 프로젝트 구조

```bash
article_study_assistant/
├── extension/             # Chromium 확장 프로그램 (MV3)
│   ├── background/        # 서비스 워커 및 백그라운드 AI 처리
│   ├── content/           # PDF 트레이 바 및 분할 뷰 로직
│   ├── sidepanel/         # 주요 UI 요소 (Chat, Notes, Vocab)
│   ├── libs/              # PDF.js, html2canvas 등 라이브러리
│   └── icons/             # 아이콘 에셋
├── server/                # FastAPI 백엔드 (Canonical)
│   ├── main.py            # 서버 진입점
│   ├── config.py          # 모델 및 경로 설정 (gemma4:e2b 사용)
│   ├── routers/           # API 엔드포인트 (ingest, query, notes 등)
│   ├── services/          # 핵심 로직 (llm_service, rag_service 등)
│   ├── models/            # Pydantic 스키마 정의
│   ├── data/              # 로컬 데이터 저장 (PDF, RAG, 메모)
│   └── requirements.txt   # 최신화된 파이썬 패키지 목록
└── installer/             # 원클릭 설치 프로그램
    ├── install.ps1        # 환경 설정 및 모델 다운로드 스크립트
    └── start_server.ps1   # 서버 실행 스크립트
```

---

## 🛠️ 설정 및 설치

### 1. 전제 조건
- [Python 3.10+](https://www.python.org/downloads/)
- [Ollama](https://ollama.com/) 서버가 실행 중이어야 합니다.

### 2. 자동 설치 (Windows)
1. PowerShell을 관리자 권한으로 엽니다.
2. `installer/install.ps1`을 실행하여 필요한 가상환경과 라이브러리를 설치하고 모델을 다운로드합니다.
   ```powershell
   ./installer/install.ps1
   ```

### 3. 수동 설치
1. `server` 디렉토리로 이동: `cd server`
2. 가상환경 생성 및 실행: `python -m venv venv`, `.\venv\Scripts\activate`
3. 의존성 설치: `pip install -r requirements.txt`
4. Ollama 모델 다운로드: 
   - `ollama pull gemma4:e2b`
   - `ollama pull nomic-embed-text`

---

## 🚀 실행 가이드

1. **서버 시작**: `installer/start_server.ps1`을 실행하여 FastAPI 서버를 구동합니다. (기본: http://127.0.0.1:8765)
2. **확장 프로그램 등록**:
   - 크롬 브라우저에서 `chrome://extensions` 접속.
   - '개발자 모드' 활성화.
   - '압축해제된 확장 프로그램을 로드합니다' 클릭 후 `extension` 폴더 선택.
3. **학습 시작**: 웹 브라우저에서 PDF 파일을 열면 자동으로 트레이바가 나타나며 학습이 시작됩니다.

---

## 📝 개발 개요 및 보안
- 이 시스템은 개인 학습 보조를 위해 설계되었으며, 모든 데이터는 **사용자의 로컬 환경**(data 디렉토리)에만 저장됩니다. 외부 클라우드 API를 사용하지 않으므로 오프라인 환경에서도 안전하게 사용 가능합니다.
