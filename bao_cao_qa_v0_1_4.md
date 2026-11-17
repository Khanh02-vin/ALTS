# Báo cáo QA — Local-first AI Video Studio (release/v0.1.4 + working tree)

Ngày: 2026-11-11 · HEAD `8e37279` · nhánh `release/v0.1.4`
Máy: Ubuntu (linux 7.0.0-42), GNOME Wayland + XWayland, WebKitGTK 2.4x

---

## 1. Trạng thái "app trên máy" so với dự án

| | Trước | Sau |
|---|---|---|
| Binary được chạy | AppImage v0.1.4 (đóng gói 2026-11-09) | Bản build từ working tree hiện tại |
| Đường dẫn | `~/.local/bin/Local-first.AI.Video.Studio_0.1.4.AppImage` (mount) | `~/.local/opt/local-first-ai-video-studio/usr/bin/…` |
| Có fix karaoke `\k` | Không | Có |
| Có fix relaunch | Không | Có |

- `~/.local/bin/local-first-ai-video-studio` đã trỏ sang bản working tree.
- `~/.local/opt/local-first-ai-video-studio` là symlink ổn định → `lfai-working-tree-20261110-IW0aY5`.
- Bản cũ giữ nguyên để rollback: `~/.local/bin/local-first-ai-video-studio.appimage-0.1.4`
  và `~/.local/bin/Local-first.AI.Video.Studio_0.1.4.AppImage`.
- Hai file desktop (`Local-first AI Video Studio.desktop`, `com.localfirst.aivideostudio.desktop`)
  đều gọi launcher nên icon trong app grid tự dùng bản mới — không phải sửa gì thêm.
- Dữ liệu thật (`LOCAL_FIRST_STATE_DIR` mặc định) không bị xoá/di chuyển; mọi bài test dùng
  thư mục state tạm riêng, chỉ lần chạy cuối mới dùng state thật.

---

## 2. Nguyên nhân "bấm mở app mà không có gì xảy ra, còn bị out ra"

**Kết luận cũ "code không sao" là sai.** Đây là lỗi code, xảy ra 100% trên máy này.

Chuỗi sự kiện:

1. Người dùng thu nhỏ cửa sổ → GTK báo state `ICONIFIED` → tao đặt cờ `minimized = true`.
2. Bấm icon lần nữa → process thứ hai nhận `zbus::Error::NameTaken`, gọi
   `ExecuteCallback` rồi `std::process::exit(0)` — **im lặng, không cửa sổ, không log**.
3. Callback trong app đang chạy gọi `unminimize()` → `gtk_window_deiconify()`
   → **no-op** trên GTK3 + mutter khi cửa sổ đang iconified.
4. `show()` → `gtk_widget_show_all()` → **no-op** cùng lý do.
5. `set_focus()` → tao **return sớm** vì `minimized` vẫn `true`
   (`tao-0.35.3/src/platform_impl/linux/window.rs:567`), nên `present_with_time()` —
   lời gọi duy nhất thật sự khôi phục cửa sổ — **không bao giờ được gửi**.
6. Cờ `minimized` chỉ được xoá bởi một window-state event không có `ICONIFIED`,
   mà event đó không đến vì cửa sổ chưa hề được restore.

Bằng chứng:

| Thí nghiệm | Kết quả |
|---|---|
| Lần chạy thứ hai (đo được) | exit 0, **0 byte** output, ~145 ms, cửa sổ vẫn `Iconic` |
| `gdbus call … ExecuteCallback` thủ công | trả `()` (callback có chạy) nhưng `WM_STATE` vẫn `Iconic` |
| GTK3 probe: `gtk_window_deiconify()` | `Iconic` — no-op |
| GTK3 probe: `gtk_widget_show_all()` | `Iconic` — no-op |
| GTK3 probe: `hide()` rồi `show_all()` | `Iconic` — no-op |
| GTK3 probe: `gtk_window_present()` / `present_with_time(GDK_CURRENT_TIME)` | **`Normal`** — hoạt động |
| `xdotool windowactivate` (ngoài app) | `Normal` — loại trừ window manager |

Đã loại trừ: window manager, D-Bus/plugin không chạy, sai thread (dispatcher chạy trên
GTK main context), sai window label (`main` đúng).

### Fix đã áp dụng (diff nhỏ nhất)

`apps/desktop/src-tauri/src/main.rs` — thêm `restore_main_window()`: gọi
`gtk_window().present()` trên Linux (đường duy nhất hoạt động), giữ
`show()`+`set_focus()` làm fallback cho nền tảng khác.
`apps/desktop/src-tauri/Cargo.toml` — thêm `gtk = "0.18"` cho target Linux (đã có sẵn
trong `Cargo.lock` nên không phát sinh crate mới).

Xác minh sau fix, **qua đúng launcher thật + state thật**:

```
thu nhỏ        → WM_STATE: Iconic
chạy lại       → exit 0, 5 ms, 0 byte   (vẫn là single-instance, không mở cửa sổ thứ hai)
sau đó         → WM_STATE: Normal, cửa sổ thành active, cùng pid 1520330
```

`cargo test --bin local-first-ai-video-studio`: **76 passed, 0 failed**.

Rollback: `~/.local/bin/local-first-ai-video-studio.appimage-0.1.4`.

---

## 3. Kết quả kiểm thử chức năng

| # | Hạng mục | Kết quả | Ghi chú |
|---|---|---|---|
| 1 | Khởi động app, cửa sổ hiện ra | PASS | state tạm và state thật |
| 2 | Nạp video local | PASS | |
| 3 | Tạo project + mở lại sau khi restart | PASS | đọc lại từ SQLite |
| 4 | Phân tích 0–90 s | PASS | 3 candidate, transcript outline, 2 summary version, 1 collection |
| 5 | Shorts Showcase: nhãn dominant axis + badge `CANDIDATES READY` | PASS | |
| 6 | Save → Discard → Restore một candidate | PASS | số đếm "3 active candidates · 0 discarded" khớp DB |
| 7 | Render có phụ đề (`qa-render-2.mp4`) | PASS | ffprobe + trích frame xác nhận chữ cháy đúng |
| 8 | Render sạch (`qa-render-clean.mp4`) | PASS | |
| 9 | Discard candidate cuối → xoá preview proxy dùng chung | PASS | |
| 10 | Bấm icon lần hai khi cửa sổ đang thu nhỏ | **Đã sửa** | trước: im lặng + cửa sổ mất; sau: cửa sổ hiện lại |
| 11 | Karaoke ASS (`\k`) khi burn phụ đề | **Đã sửa** | `render-engine/src/engine.rs`, có unit test |
| 12 | WebKitWebProcess biến mất sau thao tác nhập phím | **Chưa xử lý** | xảy ra 2 lần, không tái hiện ổn định; xem §4 |

---

## 4. Lỗi còn tồn tại

1. **WebKitWebProcess chết im lặng (2 lần)** — sau thao tác gõ phím trong ô nhập, tiến trình
   web biến mất, cửa sổ xám. Không tái hiện được theo kịch bản cố định nên chưa xác định
   nguyên nhân; chưa có fix.
2. **Tên file xuất bị mất dấu** — `candidate.title.replace(/[^\w-]+/g, "_")` biến tiêu đề
   tiếng Việt thành chuỗi `_` (vd. `_w_.mp4`). Chưa sửa (ngoài phạm vi đợt này).
3. **Log `Authorization required but no authorization protocol specified`** — dòng X11 vô hại
   do chạy qua XWayland, không ảnh hưởng chức năng.
4. `preview_proxy_cache_key_…` thiếu test — lỗi có sẵn, chưa sửa.

---

## 5. Ghi chú công cụ (không phải lỗi app)

- Toạ độ click của công cụ chụp màn hình lệch 1.25× (1920×1080 capture so với 1536×864
  logical) — sai số của tool, không phải của app.
- AT-SPI: `element_index` bị từ chối khi pid app và pid WebKitWebProcess khác nhau; phải dùng
  `element_identifier`.
- `setsid` làm tiến trình cha thoát sau vài ms — không phải app tự thoát.

---

## 6. Việc không làm

- Không commit, không push.
- Không sửa `.zcode/`, `gui-test-screenshots/`, output E2E, key.
- Không xoá dữ liệu thật của người dùng.
