# Báo Cáo Kiểm Toán Codebase — Lịch sử, đã lỗi thời

> **Lưu ý cập nhật 2026-11-10:** Nội dung bên dưới được giữ làm hồ sơ lịch sử, không mô tả trạng thái hiện tại của v0.1.4. Các tỷ lệ 60–65%, số đo eval và nhận định “chưa có” không còn là kết luận kiểm toán hiện hành. Xem [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) để biết trạng thái working tree, kết quả kiểm thử mới và giới hạn xác minh.
>
> Những phần đã thay đổi: scoring Hook/Summary/Impact, RMS dùng trong scoring, pause snapping, script outline/summary variants, nhãn VI/EN, deadzone crop, audio yt-dlp cho Facebook/TikTok và xóa proxy khi discard candidate cuối. Preview local có thể tạo proxy transcode thật, không chỉ metadata. Quota bỏ qua file đang ghi `*.tmp.mp4`.
>
> Những phần vẫn chưa hiện thực: Most Replayed/comments, lip-movement detection, bộ phân loại slide/chart và event bus tổng quát. Không dùng tài liệu lịch sử này để tự động mở rộng phạm vi sản phẩm.

## Tóm Tắt Kết Quả Kiểm Tra Codebase

Kiến trúc trong tài liệu thiết kế **khớp một phần — khoảng $60\text{--}65\%$** so với mã nguồn thực tế của dự án. Những thành phần đã có trong repo thường ở dạng **đơn giản và thực dụng hơn (Pragmatic MVP)** so với mô tả lý thuyết; ba thành phần **hoàn toàn chưa tồn tại** gồm: *Most Replayed heatmap*, *comments + timestamps*, và **Scoring Engine 3 trục**. Ngoài ra, có một điểm lệch kiến trúc cơ bản: ứng dụng hiện tại **không chạy theo mô hình event-driven** — không có lệnh `emit` hay `listen` nào trong tầng Rust mà dùng cơ chế `Channel` + Polling + khóa đơn luồng.

---

## 1. Bảng Đối Chiếu Chi Tiết Từng Phân Hệ (Design Doc vs. Repo Thực Tế)

| Thiết kế đề xuất (Doc) | Thực tế trong Repo | Bằng chứng trong mã nguồn (Evidence) |
|---|---|---|
| **Ingestion**: Chuẩn hoá URL | Có, áp dụng allowlist host chặt chẽ | `apps/desktop/src-tauri/src/youtube.rs` — `youtube.com/www/m/youtu.be`, `tiktok.com/www/vm/vt`, short link `vm.`/`vt.` phải đúng $1$ path segment |
| `yt-dlp` tải media | Chỉ dùng `--skip-download` lấy metadata; lúc render mới resolve CDN URL + range-request đoạn đã chọn | `youtube.rs` (`resolve_stream_url`) |
| Audio-first WAV $16\text{ kHz}$ mono | Decode duy nhất một lần, tái sử dụng cho cả VAD + Whisper | `src/analysis.rs` (`ANALYSIS_PREEXTRACTED_AUDIO`) |
| Video proxy nhẹ | Có nhưng hoạt động theo cơ chế **lazy + vì tương thích codec**, không nằm ở tầng ingestion; cache LRU $5\text{ GiB}$ | `src/preview.rs:10-46`, `prepare_video_preview` |
| **Most Replayed heatmap** | **Không có** | `grep "heatmap\|most_?replayed"` $\rightarrow$ rỗng toàn repo |
| **Comments + timestamps** | **Không có** | `grep "comment"` trong `youtube.rs`/`scripts` $\rightarrow$ rỗng |
| **Analysis**: Silero VAD | Có `VadSegmenter` + `models/silero_vad.onnx` | `src/diarization.rs` (`diarization_setup_status`), `crates/ai-engine` |
| Faster-Whisper word-level | Có `--word_timestamps True`, hỗ trợ chunked + `whisper.cpp` alt + weights `tiny`/`base` bundle sẵn | `adapters/local/whisper.ts`, `chunked-whisper.ts` |
| **RMS audio peaks** | Không dùng làm tín hiệu chấm điểm. Chỗ duy nhất có RMS là *embedding giả* cho segment chưa train | `crates/ai-engine/src/lib.rs:781-785` |
| **LLM sinh script/hook** | LLM chỉ trả `title`/`score`/`reason` cho mỗi highlight, và sinh **edit variants** (tối đa $4$, chuỗi word-range) | `services/ai-pipeline/providers.ts:96-110`, `variants.ts` (`VARIANT_OUTPUT_SCHEMA`) |
| Cắt theo "complete thought" | Chỉ là **điểm cộng** ($+10$) cho câu trọn vẹn, không tự động kéo biên về ranh giới câu | `heuristic.ts` (`complete ? 10 : 0`) |
| **Snap vào khoảng lặng $\ge 0.3\text{s}$** | **Khác biệt rõ**: pause $\ge 0.7\text{s}$ được cộng **$+8\text{ điểm}$**, biên cắt vẫn nằm ở word/segment edge | `heuristic.ts`: `const PAUSE_SECONDS = 0.7` |
| **Reframe**: Track subject/speaker | Có, chọn mặt người nói, yêu cầu mapping `speaker` $\rightarrow$ `face` được confirm | `diarization.rs` (`analyze_crop_path`, `track_crop_path`); `crop-keyframes.ts:48-67` giới hạn confidence $0.49$ nếu chưa confirm |
| **Lip movement** | **Không có** | `grep "lip\|mouth"` $\rightarrow$ rỗng |
| Deadzone anti-jitter | Đang dùng **EMA $\alpha = 0.35$ + cắt scene khi dịch chuyển $\ge 0.35$**, không phải dải deadzone giữ nguyên vị trí | `diarization.rs` (`track_crop_path`) |
| Adaptive layout (close-up / 2 người / blur nền) | `solo` có, `side-by-side` có, `blur` nền có — nhưng blur chỉ là **fill letterbox**, chưa tự quyết định theo loại nội dung slide/chart | `crates/render-engine/src/engine.rs:421,470` (`hstack`), `:676` (`gblur=sigma=24`), `:546` (OCR delogo) |
| **Scoring 3 trục $w_1 \cdot S_{hook} + w_2 \cdot S_{summary} + w_3 \cdot S_{impact}$** | **Không có**. Chỉ có duy nhất **một điểm số `score` $0\text{--}100$** | `heuristic.ts`: `min(100, wordCount*5 + hook 25 + complete 10 + pause 8)`; LLM: `providers.ts` (`mapWordRangeProposals` clamp $0\text{--}100$) |
| Hook = $3\text{ giây}$ đầu | Đang quét **regex keyword trên toàn bộ window**, không giới hạn theo vị trí đầu clip | `heuristic.ts:5` `HOOK_WORDS` |
| Summary = cosine với embedding | Không có trong scoring. Embedding hiện chỉ phục vụ **RAG search** trong YouTube Studio | `/api/rag/query`, `--embeddings --pooling mean` |
| Impact = LLM phán self-contained/kết bất ngờ | Chỉ có `reason` dạng free-text + $1$ điểm tổng; tính self-contained đang xấp xỉ bằng heuristic | `providers.ts:98` (prompt) |
| **Auto labels** ("Tóm tắt chuẩn nhất"…) | **Không có**. Chỉ có `collections.ts` gom nhóm highlight theo từ chung trong `title`/`hook`/`reason` | `services/ai-pipeline/collections.ts:41-50` |
| **Preview**: Metadata-only, không stitch | Có: Editor phát video gốc + `<track kind="captions">` + overlay crop từ `plan.cropKeyframes` | `Editor.svelte:152-185, 360` |
| Render theo clip đã chọn | Có: hỗ trợ multi-select $\rightarrow$ gọi `render_video` cho mỗi range | `Studio.svelte:63, 705-713, 598/690/748` |
| **Auto GC** (giữ JSON, xoá buffer clip không chọn) | **Chỉ có** cơ chế LRU quota ($5\text{ GiB}$) cho preview cache. Chưa có GC xóa riêng theo "clip bị từ chối" | `preview.rs:10-46` |
| **Event-driven** | **Không có event bus**. Render dùng `tauri::ipc::Channel<RenderProgress>`. Analysis dùng poll `HashMap` + SQLite, khóa $1$ slot | `grep "emit(\|listen("` $\rightarrow$ rỗng |

---

## 2. Ba Điểm Lệch Kiến Trúc Đáng Lưu Ý Nhất

1. **Không Event-Driven:** Tài liệu thiết kế mô tả "event-driven pipeline", trong khi mã nguồn thực tế hoạt động theo cơ chế **Command + Channel + Poll** với chốt khóa đơn luồng (`ANALYSIS_RUNNING` khóa $1$ slot trong `analysis.rs`, `RENDER_BUSY` dùng CAS guard trong `render.rs`). Đây không phải là lỗi mà là thiết kế an toàn giúp bảo vệ RAM/CPU trên máy cá nhân, nhưng tài liệu và kế hoạch mở rộng cần bám sát cơ chế này.
2. **Scoring Engine 3 trục gần như chưa có:** Tài liệu mô tả $3$ trục điểm + trọng số + nhãn tự động, nhưng code hiện tại chỉ có $1$ điểm số heuristic tổng hợp. Dự án đã có sẵn bộ kiểm thử đánh giá chất lượng `tests/ai-pipeline/eval-highlights.test.ts` (đo IoU + rank@$1$/$3$/$5$, ngưỡng $0.3$), do đó mọi nâng cấp về Scoring đều phải được đo kiểm bằng bộ test này thay vì chỉnh sửa cảm tính.
3. **Khác biệt giữa Snap và Bias khoảng lặng:** Tài liệu mô tả biên clip *dịch chuyển (snap) vào* khoảng lặng $\ge 0.3\text{s}$, trong khi code hiện tại chỉ *cộng điểm thưởng ($+8$)* cho cửa sổ có khoảng nghỉ $\ge 0.7\text{s}$. Nếu dịch chuyển biên cắt trực tiếp trong lúc quét sẽ làm thay đổi baseline IoU ($0.75$) của bộ test.

---

## 3. Định Hướng Local-First vs. Cloud (BYOK) Dựa Trên Số Đo Thực Tế

Chiến lược chuẩn xác nhất cho codebase này là: **Local-First mặc định, Cloud chỉ là tùy chọn bật thêm theo khóa cá nhân (Opt-in BYOK)**.

* **Chuỗi quyết định chiến lược (`resolveHighlightStrategy` tại `services/ai-pipeline/index.ts:31-38`):** Ưu tiên biến môi trường chỉ định rõ $\rightarrow$ OpenAI-compatible (nếu có key) $\rightarrow$ Gemini (nếu có key) $\rightarrow$ **Heuristic Offline**. Không có key đồng nghĩa với việc không phát sinh bất kỳ lưu lượng mạng nào ra ngoài (Zero Egress).
* **Mô hình ngữ nghĩa cục bộ (`semantic-local`):** Đóng gói kèm `llama-server` + `Qwen2.5-3B Q4 GGUF`, không cần API key, không gửi dữ liệu ra mạng (`docs/local-llm.md`).
* **Nhận diện giọng nói (ASR):** Luồng mặc định chạy `whisper` CLI cục bộ, tự động chép trọng số (`tiny`/`base`) vào `~/.cache/whisper`. `OpenAITranscriptionProvider` (`providers.ts:14-26`, `whisper-1`) chỉ là một tùy chọn thay thế.
* **Nguồn YouTube:** Lấy phụ đề trực tiếp qua `youtube-transcript-api`, không tốn tài nguyên chạy Whisper nếu video đã có sẵn phụ đề.
* **Ranh giới bảo mật:** Cờ `DIARIZATION_LOCAL_SOURCE_ONLY` kiểm soát chặt đầu vào; các tiến trình sidecar chỉ lắng nghe trên loopback kèm token riêng cho từng phiên làm việc.
* **Bằng chứng thực nghiệm từ bộ đo (`eval-highlights.test.ts`):** Kết quả đo cho thấy mô hình nhỏ `Qwen 0.5B` thua xa bộ luật `heuristic` (IoU $0.02$ so với $0.75$). Do đó, việc giữ `heuristic` làm mặc định và chỉ bật `semantic-local` (với model $\ge 1.5\text{B}$) hoặc Cloud BYOK khi người dùng chọn là hoàn toàn có cơ sở khoa học.

**Nguyên tắc bắt buộc khi bật Cloud BYOK:**
1. Chỉ gửi **văn bản phụ đề (text transcript)**, tuyệt đối không tải file âm thanh hay hình ảnh lên đám mây.
2. Phải là cơ chế Opt-in có chỉ báo rõ ràng trên giao diện người dùng.
3. Luôn giữ khối `try/catch` tự động lùi về (fallback) `heuristic` nếu API lỗi (như mẫu có sẵn trong `analyzeLocalVideoWithSemantic`, `index.ts:89-102`).
4. Giữ nguyên cơ chế lưu đệm `llm-cache.ts` để tránh tốn token khi chạy lại.

---

## 4. Tám Câu Hỏi Kiến Trúc Cần Chốt Trước Khi Code

1. **Heatmap + comments có thực sự cần trong v0.1.3?** Cả hai đều chưa có và đòi hỏi phải viết bộ cào dữ liệu riêng ngoài phụ đề.
2. **Snap hay Bias khoảng lặng?** Nếu dịch biên thật thì phải giải quyết bài toán thay đổi điểm IoU baseline trong bộ test.
3. **Làm đủ 3 trục điểm hay giữ 1 điểm tổng?** Nếu làm 3 trục thì thiết kế sao cho không ép máy yếu phải chạy `llama-server` nặng nề?
4. **Nhãn tự động (Auto label) xử lý đa ngôn ngữ thế nào?** Trả về chuỗi tiếng Việt cứng hay trả về mã định danh (enum) cho tầng UI?
5. **Adaptive layout có cần chế độ nhận diện Slide/Chart để làm mờ nền không?** Làm sao tận dụng bộ lọc `gblur=sigma=24` sẵn có mà không cần chạy thêm mô hình phân loại hình ảnh nặng?
6. **Ngưỡng `0.35` trong `track_crop_path` là ngưỡng cắt cảnh hay dải chống rung (Deadzone)?** Hiện code đang dùng `0.35` để cắt cảnh; cần bổ sung dải deadzone thật như thế nào để triệt tiêu rung lắc nhẹ (micro-jitter)?
7. **Dọn rác (GC) cho "clip không chọn" xử lý ở mức nào?** Khi `preview.rs` đã có giới hạn LRU $5\text{ GiB}$, việc xóa bộ đệm nên thực hiện ra sao?
8. **Giữ nguyên `Channel` + Poll hay đập đi xây lại Event Bus?**