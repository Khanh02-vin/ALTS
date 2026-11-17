# Thiết Kế Hệ Thống AI Video Repurposing & Cấu Hình Desktop Siêu Nhẹ

> **Đối chiếu v0.1.4 — 2026-11-10:** Đây là tài liệu thiết kế, không phải toàn bộ tính năng đã giao. Các sơ đồ và công nghệ đề xuất bên dưới vẫn bao gồm hướng phát triển chưa triển khai (Most Replayed/comments, event bus, phân loại slide/chart, MediaPipe/YOLO). Runtime hiện dùng Command + Channel + polling; nhận diện mặt dùng Haar. Các con số dung lượng/RAM/tốc độ là ước tính thiết kế, không phải benchmark của bản phát hành. Trạng thái và kiểm thử thực tế: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## Phần 1: Yêu Cầu Gốc Của Bài Toán

1. **Nguồn đầu vào đa dạng:** Chọn video từ máy cá nhân (Local file), link TikTok, link Facebook và link YouTube.
2. **Xử lý bằng công nghệ, thuật toán, mẹo lẻ và AI:**
   - **2.1.** Tạo phụ đề cho video.
   - **2.2.** Tạo script theo cấu trúc `[Thời gian : Nội dung]` giống như các điểm Hook / Chapters trên YouTube.
   - **2.3.** Tách thành các video ngắn với nội dung hoàn chỉnh (dựa trên kết quả từ bước 2.2).
   - **2.4.** Tạo khung hình dọc ($9:16$) cho video ngắn để phù hợp với các nền tảng video ngắn hiện tại (TikTok, Reels, Shorts).
3. **Lưu trữ có chọn lọc:** Lưu các video ngắn (cho phép người dùng chọn lưu hoặc không lưu).
4. **Chấm điểm đa chiều:** Từ các video ngắn, chấm điểm chúng theo 3 hướng: nội dung thú vị (Hook), bao quát nội dung của cả video dài (Summary), hoặc chỉ đơn giản là một video ấn tượng độc lập (Impact).

---

## Phần 2: Kiến Trúc Tổng Thể (Event-Driven & Score-First, Render-Later)

Hệ thống tái chế video dài thành video ngắn (AI Video Repurposing Pipeline) được thiết kế theo cơ chế **Đánh giá trước - Kết xuất sau (Score-First, Render-Later)** để tránh lãng phí tài nguyên phần cứng cho các đoạn video kém chất lượng.

### 1. Sơ đồ Kiến trúc Tổng thể

```text
[ĐẦU VÀO: File / YouTube / TikTok / FB]
                  |
                  v
+-----------------------------------------+
| 1. INGESTION & PROXY ENGINE             |
| - Chuẩn hóa URL & tải luồng (yt-dlp)    |
| - Tách Audio 16kHz + Video Proxy nhẹ    |
| - Thu thập Heatmap (Most Replayed)      |
+-----------------+-----------------------+
                  |
                  v
+-----------------------------------------+
| 2. AI ANALYSIS & SCRIPTING (Bước 2.1-2.3)|
| - VAD + ASR: Tạo phụ đề cấp độ từng từ  |
| - Audio Peak + LLM: Tạo Script & Hook   |
| - Semantic Cut: Cắt đoạn hoàn chỉnh ý   |
+-----------------+-----------------------+
                  |
                  v
+-----------------------------------------+
| 3. SCORING ENGINE (Bước 4 - Đánh giá)   |
| - Chấm điểm: Độ thú vị (Hook),          |
|   Độ bao quát (Summary), Độ ấn tượng    |
| - Xếp hạng & lọc ra Top ứng viên        |
+-----------------+-----------------------+
                  |
                  v
+-----------------------------------------+
| 4. SMART REFRAMING & PREVIEW (Bước 2.4) |
| - Bám theo chủ thể (Face/Speaker Track) |
| - Chuyển khung 9:16 + Xem trước trên UI |
+-----------------+-----------------------+
                  |
         [Người dùng duyệt] (Bước 3)
          +-- Hủy --> Xóa cache tạm
          +-- Lưu --> FFmpeg Render Full HD --> Lưu trữ (Local/Cloud)
```

### 2. Thiết kế Chi tiết Từng Phân hệ & Mẹo Tối ưu

#### Phân hệ 1: Thu thập & Tiền xử lý (Ingestion Layer)
Thay vì tải toàn bộ video chất lượng cao ngay từ đầu gây nghẽn mạng và đầy ổ cứng, phân hệ này ưu tiên xử lý luồng âm thanh trước.
* **Bộ định tuyến nguồn (Source Router):** Tự động nhận diện file nội bộ hoặc bóc tách luồng trực tiếp từ link TikTok, Facebook, YouTube thông qua trình trích xuất đa nền tảng (`yt-dlp`).
* **Mẹo tải Audio-First:** Chỉ tải trước luồng âm thanh nhẹ (WAV $16\text{ kHz}$ Mono) để chạy AI phân tích kịch bản, chỉ tải phần hình ảnh độ phân giải cao ở đúng các mốc thời gian được chọn.
* **Tận dụng dữ liệu đám đông:** Với link YouTube, có thể trích xuất dữ liệu biểu đồ nhiệt (Most Replayed) và bình luận có gắn mốc thời gian để làm tín hiệu gợi ý đoạn cao trào.

#### Phân hệ 2: Tạo Phụ đề, Kịch bản & Cắt đoạn (Bước 2.1, 2.2, 2.3)
Phân hệ này kết hợp xử lý tín hiệu âm thanh và mô hình ngôn ngữ lớn (LLM) để đảm bảo đoạn cắt không bị cụt ý hoặc lệch chữ.
* **Tạo phụ đề cấp từ (Bước 2.1):** Luồng Whisper cục bộ cung cấp word timestamps; YouTube ưu tiên captions khi có. Silero VAD hiện được dùng trong diarization, không phải bộ gọt biên highlight. `pause-snap.ts` dịch biên dựa trên khoảng nghỉ giữa các từ từ 0.3 giây và dấu câu, giới hạn dịch chuyển 0.5 giây; đây là heuristic theo transcript, không phải phép đo VAD trực tiếp.
* **Tạo Script cấu trúc và bắt điểm Hook (Bước 2.2):** Đưa bản chép lời vào LLM/Heuristic để tóm tắt thành cấu trúc `[Thời gian : Nội dung]`, kết hợp đo cường độ âm thanh (RMS Energy) để phát hiện giọng nói cao trào.
* **Cắt video ngắn trọn vẹn ngữ nghĩa (Bước 2.3):** Gom nhóm các câu có cùng chủ đề thành đoạn từ $30$ đến $90$ giây có đủ mở đầu, cao trào và kết thúc.
* **Mẹo gọt biên âm thanh (Silence Snapping):** Dịch chuyển điểm cắt đầu và cuối của đoạn video khớp vào các khoảng nghỉ lấy hơi (từ $0.3\text{ giây}$ trở lên) để câu nói không bị đứt ngang.

#### Phân hệ 3: Đóng khung $9:16$ Thông minh (Bước 2.4 - Smart Reframing)
Để chuyển video ngang ($16:9$) sang dọc ($9:16$) cho TikTok, Reels và Shorts mà không làm mất chủ thể hoặc gây chóng mặt, hệ thống áp dụng thuật toán bố cục động:
* **Nhận diện chủ thể đang nói:** Dùng mô hình thị giác máy tính nhẹ (MediaPipe hoặc YOLO) phát hiện khuôn mặt để xác định ai đang là tâm điểm khung hình.
* **Mẹo chống rung khung hình (Deadzone Smoothing):** Thiết lập một vùng an toàn ở giữa màn hình; khung cắt chỉ di chuyển mượt khi người nói bước hẳn ra ngoài vùng này thay vì giật theo từng chuyển động nhỏ.
* **Bố cục thích ứng đa khung (Adaptive Layout):** Tự động cắt cận cảnh nếu chỉ có một người (`solo`), chia đôi màn hình (`side-by-side`) khi có hai người đối thoại, hoặc chèn nền mờ (`blur`) nếu không có mặt người (slide/biểu đồ trình chiếu).

#### Phân hệ 4: Hệ thống Chấm điểm Đa chiều (Bước 4 - Scoring Engine)
Đưa bước chấm điểm lên trước bước xuất file nặng giúp người dùng biết ngay đoạn nào đáng giá. Mỗi đoạn cắt được đánh giá trên thang điểm $100$ dựa theo $3$ trục độc lập:

$$S_{total} = w_1 \cdot S_{hook} + w_2 \cdot S_{summary} + w_3 \cdot S_{impact}$$

* **Điểm thú vị / Bắt trend ($S_{hook}$):** Đánh giá $3\text{--}5\text{ giây}$ đầu tiên dựa trên câu hỏi gợi tò mò, từ khóa cảm xúc mạnh, tốc độ nói nhanh và độ vọt âm thanh.
* **Điểm bao quát nội dung ($S_{summary}$):** Đo độ tương đồng ngữ nghĩa / độ phủ từ khóa giữa đoạn cắt và toàn bộ nội dung bài, xác định đoạn video có đại diện cho ý chính của cả video dài hay không.
* **Điểm ấn tượng độc lập ($S_{impact}$):** Đánh giá mức độ tự thân hoàn chỉnh (người lạ xem có hiểu ngay mà không cần ngữ cảnh trước đó hay không) và tính bất ngờ ở cuối clip.
* **Phân loại nhãn tự động:** Pipeline trả mã trục `hook` / `summary` / `impact` qua `dominantAxis`. Studio ánh xạ theo ngôn ngữ transcript: tiếng Việt dùng `Mở đầu` / `Tóm tắt` / `Tác động`, ngôn ngữ khác dùng `Hook` / `Summary` / `Impact`. Không hardcode các nhãn quảng bá như “Tóm tắt chuẩn nhất”.

#### Phân hệ 5: Xem trước, Duyệt & Lưu trữ (Bước 3 - Selective Storage)
Khâu cuối cùng tách biệt việc xem thử (Preview) và việc xuất file thật (Render):
* **Preview theo nguồn:** Với video local, `prepare_video_preview` có thể transcode một proxy MP4 tương thích trình phát, dùng chung cho các candidate của nguồn đó. Cache key dựa trên đường dẫn, kích thước và mtime nguồn. Đây không phải preview chỉ bằng metadata, cũng không phải final render riêng cho từng candidate. YouTube dùng embed; Facebook/TikTok có liên kết mở bài gốc, chưa có embed tương đương.
* **Kết xuất theo yêu cầu (On-demand Rendering):** Chỉ những đoạn người dùng chọn xuất mới đi qua final renderer để tạo MP4; việc burn phụ đề phụ thuộc toggle của người dùng.
* **Dọn cache có giới hạn:** Khi discard candidate active cuối của một nguồn local, UI yêu cầu xóa proxy dùng chung; lỗi xóa không chặn thao tác discard. Sau mỗi lần publish proxy, quota best-effort 5 GiB dọn các MP4 đã hoàn tất theo mtime cũ nhất. File đang ghi `*.tmp.mp4` không tính vào quota và không bị eviction. Không cam kết xóa sạch mọi buffer; cache hit không cập nhật mtime nên đây không phải LRU theo lần truy cập thực sự.

---

## Phần 3: Thiết Kế Kiến Trúc Desktop App (Local-First & Sidecar)

Để vận hành hệ thống như một ứng dụng máy tính (Desktop App) mượt mà trên phần cứng cá nhân, kiến trúc sử dụng mô hình **Local-First kết hợp Tiến trình phụ (Sidecar Architecture)**. Thay vì nạp toàn bộ mô hình AI cùng lúc gây tràn RAM và treo máy, ứng dụng điều phối các công cụ chạy ngầm theo chuỗi tuần tự và dùng cơ chế dựng hình ảo trên giao diện.

### 1. Sơ đồ Kiến trúc Desktop App

```text
+----------------------------------------------------------------------+
|                        FRONTEND UI (WebView)                         |
|  [Nhập Link/File] --> [Trình phát Xem thử 9:16 Ảo] --> [Bảng Điểm]   |
+------------------+-----------------------------------+---------------+
                   | Lệnh điều khiển (IPC Commands)    | Sự kiện tiến độ
                   v                                   | (IPC Channels)
+------------------------------------------------------+---------------+
|                    CORE BACKEND (Trình điều phối)                    |
|  - Quản lý Hàng đợi (Task Queue) & Vòng đời Tiến trình (Sidecars)    |
|  - Quản lý Bộ nhớ đệm (Cache GC) & Cơ sở dữ liệu nhúng (SQLite)      |
+----+--------------+-----------------+-----------------+--------------+
     |              |                 |                 |
     v              v                 v                 v
+----------+  +-----------+   +---------------+  +--------------+
| yt-dlp   |  | Whisper   |   | Local LLM/API |  | MediaPipe +  |
| (Tải về) |  | (Phụ đề)  |   | (Cắt & Chấm)  |  | FFmpeg (Xuất)|
+----------+  +-----------+   +---------------+  +--------------+
```

### 2. Phân tầng Công nghệ Đề xuất

| Tầng hệ thống | Công nghệ đề xuất | Vai trò trong ứng dụng | Cơ chế tối ưu |
|---|---|---|---|
| **Giao diện** | Tauri v2, Svelte hoặc React | Hiển thị bảng điểm, chỉnh phụ đề và xem thử | Dùng WebView hệ điều hành giúp giảm $80\%$ RAM so với Electron |
| **Nhân điều phối** | Rust + TypeScript Pipeline | Quản lý luồng dữ liệu, hàng đợi và ổ cứng | Giao tiếp bất đồng bộ qua IPC không làm đơ giao diện |
| **Tải & Xử lý Media** | `yt-dlp` và `FFmpeg` đóng gói sẵn | Tải video đa nền tảng, tách âm thanh và cắt file | Chạy dưới dạng tiến trình con độc lập, tự tắt khi xong |
| **Nhận diện & AI** | `Whisper.cpp`, `Llama.cpp`, ONNX | Tạo phụ đề, tìm điểm Hook, chấm điểm và bám mặt | Lượng tử hóa mô hình ($4\text{-bit}$/$8\text{-bit}$) để chạy mượt trên CPU/iGPU |
| **Lưu trữ nội bộ** | SQLite và Thư mục tạm | Lưu kịch bản, tọa độ khung hình và điểm số | Truy vấn tức thì từ một file cơ sở dữ liệu duy nhất |

### 3. Cơ chế Quản lý Tài nguyên Máy Cá nhân (Chuỗi Nạp - Xả Tuần tự)

1. **Tách luồng nhẹ:** Khi nhận file hoặc link từ YouTube, TikTok, Facebook, hệ thống dùng `yt-dlp` và `FFmpeg` trích xuất trước luồng âm thanh nhẹ chuẩn $16\text{ kHz}$ Mono để xử lý ngay.
2. **Nạp tuần tự:** Ứng dụng gọi `Whisper.cpp` để tạo phụ đề chính xác đến từng từ (Bước 2.1), lưu kết quả vào SQLite rồi giải phóng hoàn toàn mô hình nhận diện giọng nói khỏi RAM.
3. **Chấm điểm trước:** Bộ chấm điểm (Heuristic hoặc LLM cục bộ / API) đọc văn bản phụ đề kết hợp biên độ âm thanh để gom nhóm các đoạn video ngắn hoàn chỉnh (Bước 2.2, 2.3) và chấm luôn $3$ đầu điểm Thú vị, Bao quát, Ấn tượng (Bước 4).
4. **Lấy mẫu thưa:** Thay vì quét khuôn mặt trên toàn bộ video dài hàng giờ, bộ nhận diện chủ thể (Bước 2.4) chỉ chạy trên các đoạn cắt đạt điểm cao và chỉ quét $3$ đến $5\text{ FPS}$ rồi dùng thuật toán nội suy để làm mượt chuyển động khung $9:16$.
5. **Xem thử trước final render:** Với nguồn local, trình phát có thể dùng proxy MP4 đã transcode và lưu cache theo nguồn; không bảo đảm đọc trực tiếp video gốc hoặc mở tức thì ở lần đầu. Các thông số chỉnh sửa được giữ trong RenderPlan, còn MP4 cuối chỉ được xuất khi người dùng yêu cầu.

---

## Phần 4: Ước Tính Dung Lượng & Cấu Hình Siêu Nhẹ (Ultra-Light Stack)

### 1. Bộ cài cốt lõi & Công cụ nền ($\sim 150\text{ MB} \text{ -- } 220\text{ MB}$)
* **Khung giao diện & Nhân điều phối (Tauri + SQLite):** $\sim 15\text{ MB} \text{ -- } 25\text{ MB}$.
* **Bộ công cụ Media đi kèm (Sidecar Binaries):**
  * `ffmpeg` & `ffprobe` (bản rút gọn tĩnh): $\sim 80\text{ MB} \text{ -- } 120\text{ MB}$.
  * `yt-dlp` (file thực thi độc lập): $\sim 15\text{ MB} \text{ -- } 30\text{ MB}$.
  * Engine chạy AI (`whisper.cpp` / `llama.cpp` CLI hoặc ONNX Runtime): $\sim 20\text{ MB} \text{ -- } 40\text{ MB}$.

### 2. Bảng So sánh 3 Cấu hình Mô hình AI (Từ Siêu Nhẹ đến Offline 100%)

| Thành phần AI | Chức năng chính | Cấu hình Siêu nhẹ (Khuyên dùng cho máy yếu) | Cấu hình Nhẹ (Hybrid) | Cấu hình Offline 100% |
|---|---|---|---|---|
| **Whisper.cpp** | Nhận diện giọng nói (Bước 2.1) | **$\sim 40\text{ MB} \text{ -- } 75\text{ MB}$** (`tiny.en` hoặc `tiny` quantized Q5) | $\sim 150\text{ MB}$ (Base Q5) đến $500\text{ MB}$ (Small Q5) | $\sim 500\text{ MB}$ (Small Q5) đến $1.5\text{ GB}$ (Medium Q5) |
| **Silero VAD** | Phân đoạn giọng nói trong diarization; không gọt biên highlight | **$\sim 2\text{ MB}$** (ONNX) | $\sim 2\text{ MB}$ (ONNX) | $\sim 2\text{ MB}$ (ONNX) |
| **Bám mặt / $9:16$** | Đóng khung video (Bước 2.4) | **$\sim 5\text{ MB} \text{ -- } 10\text{ MB}$** (Model ONNX nhẹ / Smart Center Crop) | $\sim 10\text{--}30\text{ MB}$ (MediaPipe/YOLO) | $\sim 10\text{--}30\text{ MB}$ (YOLOv8 Nano) |
| **Embedding Model** | Đo độ bao quát nội dung | **$0\text{ MB}$** (Dùng TF-IDF/BM25 nhẹ hoặc Cloud API) | $\sim 50\text{--}100\text{ MB}$ (`all-MiniLM` ONNX) | $\sim 100\text{--}300\text{ MB}$ (Multilingual E5) |
| **LLM (Script & Chấm điểm)** | Tạo Hook, cắt đoạn, chấm điểm | **$0\text{ MB}$** (Heuristic Offline $0\text{ MB}$ + Cloud BYOK Gemini/OpenAI) | $0\text{ MB}$ (Gọi Cloud API) | $\sim 2.0 \text{ -- } 4.5\text{ GB}$ (Qwen/Llama $3\text{B--}7\text{B}$ GGUF Q4) |
| **TỔNG DUNG LƯỢNG TĨNH** | **Không gian lưu trên ổ cứng** | **$< 100\text{ MB}$** (Models) | **$\sim 350\text{ MB} \text{ -- } 750\text{ MB}$** | **$\sim 3.0\text{ GB} \text{ -- } 6.0\text{ GB}$** |
| **ĐỈNH RAM KHI CHẠY** | **Mức ngốn RAM tối đa** | **$\sim 500\text{ MB} \text{ -- } 800\text{ MB}$** | $\sim 1.0\text{ GB} \text{ -- } 1.8\text{ GB}$ | $\sim 3.5\text{ GB} \text{ -- } 6.5\text{ GB}$ |

### 3. Dung lượng Đệm tạm thời khi xử lý 1 dự án ($\sim 500\text{ MB} \text{ -- } 2\text{ GB}$ / video)
* **Video gốc tải về / Preview Cache:** Ước tính $\sim 400\text{ MB} \text{ -- } 1.5\text{ GB}$ tùy nguồn. Proxy được tạo theo nhu cầu; quota best-effort 5 GiB chỉ tính MP4 đã publish và dọn theo mtime, không tính file đang ghi `*.tmp.mp4`. Đây không phải giới hạn tổng dung lượng của mọi file tải về/tạm, cũng không phải LRU theo lần truy cập.
* **File âm thanh tách riêng (WAV $16\text{ kHz}$ Mono):** $\sim 115\text{ MB}$ cho mỗi $1\text{ giờ}$ âm thanh (xóa ngay sau khi bước phân tích hoàn tất).
* **Dữ liệu JSON phụ đề, điểm số & tọa độ khung hình:** Dưới $5\text{ MB}$ (lưu trong SQLite).
* **Các video ngắn đã xuất (MP4 $9:16$):** Khoảng $15\text{ MB} \text{ -- } 40\text{ MB}$ cho mỗi clip dài $60\text{ giây}$.

### 4. Bốn Giải pháp Tối ưu trong Cấu hình Siêu nhẹ
1. **Dùng Whisper phiên bản `tiny`/`base` quantized:** Nặng từ $40\text{--}150\text{ MB}$, tốc độ xử lý cực nhanh trên CPU (nhanh gấp $4\text{--}5\text{ lần}$ bản Small/Medium).
2. **Kết hợp Định tâm Thông minh & Bám mặt Lấy mẫu thưa:** Chỉ quét mặt trên các đoạn được chọn hoặc dùng quy tắc phần ba (Rule of Thirds) kết hợp dịch khung mượt theo biên độ âm thanh (Audio-driven Panning).
3. **Loại bỏ hoàn toàn Embedding Model cục bộ nặng:** Dùng thuật toán đo độ phủ từ khóa (TF-IDF / Keyword Overlap) tốn $0\text{ MB}$ RAM cho chế độ Offline mặc định, và chỉ gọi LLM API hoặc Local Server khi người dùng chủ động bật.
4. **Tận dụng bộ nhớ đệm thông minh (Smart Caching):** Lưu trữ toàn bộ kết quả phụ đề và điểm số vào SQLite cùng bộ đệm LLM (`llm-cache.ts`), phản hồi dưới $0.1\text{ giây}$ khi mở lại dự án.