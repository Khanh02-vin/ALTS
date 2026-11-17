# Quyết Định Kiến Trúc, Giải Pháp Facebook Video & Bản Chỉ Thị Coding Agent

## Phần 1: Quyết Định Dứt Điểm Cho 8 Câu Hỏi Kỹ Thuật

Để giữ vững mục tiêu **ứng dụng siêu nhẹ, chạy mượt trên máy cá nhân, không tràn RAM**, dưới đây là phương án chốt cho $8$ câu hỏi từ quá trình kiểm toán mã nguồn:

1. **Heatmap + Comments (v0.1.3): BỎ QUA.**
   * Việc cào bình luận và biểu đồ nhiệt làm chậm quá trình nhập dữ liệu, dễ gãy khi nền tảng đổi cấu trúc trang và vô tác dụng với file video có sẵn trong máy.
   * **Giải pháp thay thế miễn phí:** Tận dụng trực tiếp mảng biên độ âm thanh (**RMS audio peaks**) tính từ file `ANALYSIS_PREEXTRACTED_AUDIO` (WAV $16\text{ kHz}$ đã giải mã sẵn trong `analysis.rs`) để làm tín hiệu phát hiện đoạn cao trào.
2. **Snap hay Bias khoảng lặng: KẾT HỢP 2 PHA (Bias khi chấm điểm, Snap hậu kỳ sau khi chọn).**
   * **Pha 1 (Chấm điểm):** Giữ nguyên logic cộng điểm thưởng (`PAUSE_SECONDS = 0.7` được $+8\text{ điểm}$) khi quét cửa sổ để bảo toàn điểm baseline IoU $0.75$.
   * **Pha 2 (Hậu kỳ):** Chỉ thực hiện **dịch biên (Snap)** vào khoảng lặng VAD $\ge 0.3\text{s}$ trong phạm vi hẹp ($\pm 0.5\text{s}$) đối với các đoạn highlight **đã được chọn chốt**, sau đó kiểm chứng lại bằng `eval-highlights.test.ts`.
3. **Scoring 3 trục ($S_{hook}, S_{summary}, S_{impact}$): THỰC HIỆN ĐẦY ĐỦ TRÊN CẢ HEURISTIC ($0\text{ MB}$) VÀ LLM.**
   * Mở rộng cấu trúc dữ liệu của Highlight thêm đối tượng `scores: { hook: number, summary: number, impact: number }` song song với trường `score` tổng ($0\text{--}100$) để giữ tương thích ngược:
   $$\text{score} = \text{clamp}_{0..100}\left(0.4 \cdot S_{hook} + 0.3 \cdot S_{summary} + 0.3 \cdot S_{impact}\right)$$
   * Cách tính chi tiết ở chế độ Siêu nhẹ (`heuristic.ts` - $0\text{ MB}$ RAM):
     * **$S_{hook}$ (Thú vị / Mở đầu):** Chỉ tính điểm `HOOK_WORDS`, dấu chấm hỏi `?` và đỉnh âm lượng RMS trong **$3\text{--}5\text{ giây}$ đầu tiên** (hoặc $20\%$ số từ đầu đoạn) thay vì quét cào bằng cả đoạn.
     * **$S_{summary}$ (Bao quát nội dung):** Tính độ phủ từ khóa **TF-IDF / Keyword Overlap** giữa đoạn cắt và tập $20$ từ khóa quan trọng nhất của toàn bộ bài nói (nếu `semantic-local` đang bật thì dùng Cosine Similarity từ vector $896$ chiều của `llama-server`).
     * **$S_{impact}$ (Ấn tượng độc lập):** Kết hợp điểm câu trọn vẹn (`complete: +10`), khoảng nghỉ kết câu (`pause >= 0.7s: +8`), mật độ từ/giây ổn định và độ chênh lệch RMS ở cuối đoạn.
4. **Auto Labels ("Tóm tắt chuẩn nhất"…): TRẢ VỀ ENUM Ở PIPELINE, HIỂN THỊ CHUỖI Ở UI.**
   * Trong `services/ai-pipeline`, chỉ trả về trường `dominantAxis: 'hook' | 'summary' | 'impact'` (khi trục cao nhất đạt $\ge 70\text{ điểm}$). Tầng giao diện Svelte sẽ tự ánh xạ sang ngôn ngữ hiển thị để đảm bảo chuẩn đa ngôn ngữ (i18n).
5. **Adaptive Layout (Slide/Chart $\rightarrow$ Blur): THÊM NHÁNH FALLBACK `0 FACES` KHÔNG TỐN MODEL.**
   * Không cần chạy thêm OCR hay mô hình phân loại ảnh. Trong `analyze_scene_layouts`, khi số khuôn mặt được xác nhận bằng $0$ (hoặc độ tin cậy $< 0.49$), tự động chuyển sang bố cục thu nhỏ khung ngang $16:9$ nằm giữa màn hình dọc và dùng bộ lọc `gblur=sigma=24` (`engine.rs:676`) làm nền mờ.
6. **Deadzone `0.35`: TÁCH THÀNH NGƯỠNG CẮT CẢNH (`0.35`) VÀ DẢI CHỐNG RUNG TĨNH (`0.04`).**
   * Trong `track_crop_path` (`diarization.rs`), giữ `0.35` làm ngưỡng cắt chuyển cảnh tức thì (Scene Jump-Cut). Bổ sung một **dải Deadzone tĩnh bằng `0.04` ($4\%$ chiều rộng khung hình)** ngay trước bộ lọc làm mượt EMA ($\alpha = 0.35$): nếu tâm khuôn mặt mới di chuyển chưa tới $4\%$ so với vị trí hiện tại thì khóa đứng yên khung cắt, triệt tiêu hoàn toàn hiện tượng khung hình trôi nhẹ liên tục.
7. **Auto GC: XÓA FILE WAV TẠM & XÓA PREVIEW KHI BẤM "KHÔNG LƯU".**
   * Giữ nguyên giới hạn LRU $5\text{ GiB}$ trong `preview.rs`, tự động xóa file `ANALYSIS_PREEXTRACTED_AUDIO` ngay khi phân tích xong, và xóa ngay file đệm xem thử của những đoạn bị người dùng đánh dấu loại bỏ.
8. **Event Bus vs. `Channel` + Poll: GIỮ NGUYÊN KIẾN TRÚC HIỆN TẠI.**
   * Giữ nguyên `Channel<RenderProgress>` + Poll và các chốt khóa $1$ slot (`ANALYSIS_RUNNING`, `RENDER_BUSY`) để bảo vệ tài nguyên máy, chỉ cập nhật lại tài liệu thiết kế cho khớp với code.

---

## Phần 2: Phân Tích & Giải Pháp Lấy Video Từ Link Facebook

Công cụ nền `yt-dlp` hoàn toàn tải được Facebook, nhưng codebase hiện tại đang vướng **3 rào cản** cần mở khóa:

1. **Chặn bởi Allowlist trong `youtube.rs`:** File `apps/desktop/src-tauri/src/youtube.rs` hiện chỉ cho phép tên miền YouTube và TikTok. Cần mở rộng allowlist thêm `facebook.com` (`www`, `m`, `web`) và `fb.watch` với các mẫu đường dẫn `/watch`, `/videos/`, `/reel/`, `/share/v/` và `/share/r/`.
2. **Không có sẵn phụ đề rời như YouTube:** Video Facebook (và cả TikTok) hầu như không có transcript sẵn. Hệ thống phải có luồng tự động dùng `yt-dlp` tải luồng âm thanh nhẹ về `ANALYSIS_PREEXTRACTED_AUDIO` (WAV $16\text{ kHz}$ Mono) rồi đẩy qua VAD + Whisper cục bộ.
3. **Đặc thù luồng DASH và quyền truy cập CDN Facebook:** Facebook tách rời luồng hình và tiếng, đồng thời link CDN dễ hết hạn hoặc báo lỗi `403`. Giải pháp là hỗ trợ tùy chọn truyền cookie trình duyệt (`--cookies-from-browser firefox`) khi cần, và khi người dùng chọn xem sâu hoặc xuất file thì dùng `yt-dlp --download-sections "*start-end"` tải đúng phân đoạn ngắn đó (đã ghép hình + tiếng) về thư mục tạm để xử lý.

---

## Phần 3: Rà Soát 6 Điểm Bị Bỏ Sót (Blind Spots) So Với Yêu Cầu Gốc

| STT | Điểm bị bỏ sót | Hiện trạng trong Repo / Plan cũ | Giải pháp bổ sung hoàn chỉnh |
|---|---|---|---|
| **1** | **Bước 2.2: Tạo Script cấu trúc `[Thời gian : Nội dung]`** | Đang nhảy cóc từ phụ đề thô (2.1) sang danh sách clip cắt (2.3), thiếu bảng mục lục kịch bản tổng thể. | Sinh mảng `scriptOutline: Array<{ start, end, hookTitle, summary }>` lưu vào SQLite như YouTube Chapters; các clip ở bước 2.3 tham chiếu trực tiếp vào outline này và ưu tiên cắt đúng dấu kết câu (`.`, `?`, `!`). |
| **2** | **Kẹt Bước 2.4 trên nguồn Link do `DIARIZATION_LOCAL_SOURCE_ONLY`** | Cờ bảo vệ chặn hoàn toàn tính năng bám mặt $9:16$ đối với mọi link YouTube, TikTok và Facebook. | Khi người dùng chọn một đoạn highlight từ nguồn link, dùng `yt-dlp --download-sections "*start-end"` tải riêng đoạn ngắn đó về thư mục tạm local, sau đó chạy `analyze_crop_path` + `track_crop_path` trên file tạm này. |
| **3** | **Ghép nhiều đoạn (`variants.ts`) cho mục tiêu "Bao quát cả video dài"** | Một đoạn cắt liên tục $60\text{s}$ không thể tóm tắt hết video dài $1\text{ tiếng}$. | Tận dụng `variants.ts` (multi-range word-level đã có sẵn trong code) để tự động nhặt $3\text{--}4$ câu quan trọng nhất ở đầu, giữa và cuối bài ghép thành $1$ video ngắn dạng "Tóm tắt toàn cục" (`S_summary`). |
| **4** | **Luồng Fallback Whisper khi YouTube/TikTok/FB không có phụ đề** | Mặc định YouTube luôn lấy được chữ qua `youtube-transcript-api`; nếu video tắt sub sẽ gây lỗi. | Thiết lập luồng thống nhất: Thử lấy phụ đề có sẵn $\rightarrow$ nếu rỗng hoặc lỗi, tự động gọi `yt-dlp` trích xuất WAV $16\text{ kHz}$ vào `ANALYSIS_PREEXTRACTED_AUDIO` để chạy Whisper local. |
| **5** | **In cứng phụ đề (Burn-in Captions) khi xuất file MP4 ở Bước 3** | Lúc xem thử dùng thẻ `<track>` HTML5, nhưng khi xuất file MP4 độc lập sẽ mất chữ nếu không render đè lên hình. | Chuyển đổi word-level timestamps của đoạn được chọn sang bộ lọc `.ass` trong `crates/render-engine/src/engine.rs` để FFmpeg in cứng phụ đề vào vùng an toàn $1/3$ dưới của khung $9:16$. |
| **6** | **Trạng thái "Không lưu / Loại bỏ" (Discard) ở Bước 3** | Giao diện mới chỉ có chọn để Render, thiếu nút loại bỏ clip rác gắn liền với việc xóa bộ nhớ đệm. | Thêm trạng thái `discarded: boolean` trên UI (`Studio.svelte`); khi bấm loại bỏ, ẩn clip khỏi danh sách chính và xóa ngay file preview cache tương ứng trong `preview.rs`. |

---

## Phần 4: Bản Chỉ Thị Tổng Hợp (Master Prompt) Gửi Cho Coding Agent

Bạn có thể sao chép toàn bộ khối chỉ thị dưới đây và gửi thẳng cho Coding Agent để lập kế hoạch (`/write-plan`) và triển khai theo quy trình TDD:

```text
Chốt phương án kiến trúc tổng thể (ưu tiên giữ app siêu nhẹ, local-first mặc định, cloud opt-in BYOK). Hãy chạy `/write-plan` và triển khai TDD cho 14 hạng mục sau:

PHẦN A - CHỐT 8 CÂU HỎI KIẾN TRÚC:
1. Heatmap/Comments: BỎ khỏi scope v0.1.3. Thay bằng tín hiệu RMS audio energy tính trực tiếp từ file `ANALYSIS_PREEXTRACTED_AUDIO` (WAV 16kHz mono sẵn có trong `analysis.rs`).
2. Snap vs Bias khoảng lặng: Giữ nguyên bias `+8` cho `pause >= 0.7s` lúc chấm điểm cửa sổ để bảo toàn baseline IoU. Chỉ thêm bước hậu kỳ (post-selection snap) dịch biên của các highlight đã được chọn vào khoảng lặng VAD >= 0.3s trong phạm vi tối đa ±0.5s, đồng thời ưu tiên khớp dấu kết câu (`.`, `?`, `!`). Bắt buộc kiểm tra bằng `tests/ai-pipeline/eval-highlights.test.ts` để đảm bảo IoU không tụt dưới baseline.
3. Scoring 3 trục (`S_hook`, `S_summary`, `S_impact`): Nâng cấp data model của Highlight thêm `scores: { hook: number, summary: number, impact: number }` và giữ trường `score` tổng (0-100) theo công thức `clamp(0.4*hook + 0.3*summary + 0.3*impact)`.
   - Ở `heuristic.ts` (0 MB model):
     + `hook`: chỉ tính trọng số cao cho `HOOK_WORDS` + dấu `?` + đỉnh RMS nếu nằm trong 3-5 giây đầu (hoặc 20% từ đầu) của window.
     + `summary`: tính độ phủ từ khóa TF-IDF / keyword-overlap giữa window và tập từ khóa cốt lõi của toàn bộ transcript (nếu `semantic-local` đang bật thì dùng cosine similarity từ embedding 896-dim của `llama-server`).
     + `impact`: gộp điểm câu trọn vẹn (`complete`), `pause >= 0.7s`, mật độ từ ổn định và biến thiên RMS cuối đoạn.
   - Ở `providers.ts` (Cloud BYOK / Local LLM): mở rộng JSON schema trả về đủ 3 điểm thành phần + `score` tổng, giữ nguyên cơ chế fallback về heuristic và `llm-cache.ts`.
4. Auto labels: Không hardcode chuỗi tiếng Việt trong pipeline. Trả về enum `dominantAxis: 'hook' | 'summary' | 'impact'` (khi trục cao nhất >= 70) để tầng Svelte UI tự map ra nhãn hiển thị.
5. Adaptive layout (`analyze_scene_layouts`): Không dùng OCR phân loại slide. Nếu không có mặt nào được confirm (`0 faces` hoặc confidence < 0.49), fallback về layout thu nhỏ khung ngang 16:9 nằm giữa + nền mờ `gblur=sigma=24` sẵn có trong `engine.rs`.
6. Deadzone chống rung (`track_crop_path` trong `diarization.rs`): Giữ `0.35` làm ngưỡng cắt chuyển cảnh (scene jump-cut), và thêm dải deadzone tĩnh `0.04` (4% khung hình) ngay trước bộ lọc EMA (`alpha = 0.35`) để triệt tiêu micro-jitter.
7. Garbage Collection: Giữ nguyên LRU 5 GiB ở `preview.rs`, tự động xóa file WAV tạm `ANALYSIS_PREEXTRACTED_AUDIO` ngay sau khi bước `analysis` hoàn tất.
8. Kiến trúc điều phối: Giữ nguyên `Channel<RenderProgress>` + poll + guard 1 slot (`ANALYSIS_RUNNING`, `RENDER_BUSY`). Không refactor sang event bus; cập nhật lại tài liệu thiết kế cho khớp với code.

PHẦN B - BỔ SUNG 6 ĐIỂM CÒN THIẾU TỪ YÊU CẦU GỐC:
9. Hỗ trợ Facebook & Audio Fallback cho Remote Links (`youtube.rs` + `analysis.rs`):
   - Mở rộng allowlist trong `youtube.rs` hỗ trợ `facebook.com` (`www`, `m`, `web`) và `fb.watch` (`/watch`, `/videos/`, `/reel/`, `/share/v/`, `/share/r/`), cho phép cấu hình tùy chọn `--cookies-from-browser` khi cần.
   - Nếu link YouTube/TikTok/Facebook không lấy được transcript có sẵn, tự động fallback sang `yt-dlp` tải luồng audio nhẹ xuất ra `ANALYSIS_PREEXTRACTED_AUDIO` (WAV 16kHz mono) để chạy VAD + Whisper local.
10. Bước 2.2 - Structured Script Outline (`[Thời gian : Nội dung]`):
   - Trước khi cắt clip, sinh danh sách `scriptOutline: Array<{ id, start, end, hookTitle, summary }>` đại diện cho bố cục toàn video (tương tự YouTube Chapters) và liên kết từng highlight ở bước 2.3 với `outlineId` tương ứng.
11. Mở khóa Smart Reframing 9:16 cho Remote Links (Xử lý `DIARIZATION_LOCAL_SOURCE_ONLY`):
   - Khi người dùng chọn preview sâu hoặc render một highlight từ nguồn remote (YT/TikTok/FB), dùng `yt-dlp --download-sections "*start-end"` tải riêng phân đoạn ngắn đó về thư mục tạm local, sau đó chạy `analyze_crop_path` + `track_crop_path` trên file đoạn ngắn này để đóng khung 9:16 bám mặt mà không cần tải cả video dài.
12. Kết nối `variants.ts` vào trục điểm "Bao quát nội dung" (`S_summary`):
   - Bên cạnh các clip cắt liền mạch (single-range cho `hook` và `impact`), sử dụng `variants.ts` để tạo tối đa 1-2 clip dạng Multi-range Summary (ghép 3-4 phân đoạn quan trọng từ đầu, giữa và cuối video) để tạo video ngắn tóm tắt toàn bài.
13. Burn-in Phụ đề chuẩn 9:16 khi Render (`crates/render-engine/src/engine.rs`):
   - Khi xuất file MP4, chuyển word-level timestamps thành bộ lọc phụ đề (`.ass`/`subtitles`) in cứng vào vùng an toàn 1/3 dưới của khung 9:16 (có tùy chọn bật/tắt burn-in sub khi lưu).
14. Trạng thái "Lưu / Không lưu" rõ ràng ở Bước 3 (`Studio.svelte` + `preview.rs`):
   - Thêm hành động `Discard / Không lưu` cho từng highlight trên giao diện. Khi người dùng đánh dấu Không lưu, ẩn clip khỏi danh sách active và xóa ngay mọi preview cache liên quan đến dải thời gian của clip đó.
```