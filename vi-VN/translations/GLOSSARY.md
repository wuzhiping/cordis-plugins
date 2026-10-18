# Vietnamese translation brief — DSH Web GUI (vi-VN)

You are localizing the **DeepSeek Harness (DSH)** web GUI into **Vietnamese
(vi-VN)**. Your packet is `translations/chunk-NN.json`; your output is
`translations/vi-NN.json`, a flat JSON object mapping **each exact English
string** in the packet to its Vietnamese translation.

## Ground rules

1. **Cover every entry, exactly.** Output one key per input `en` string, byte
   for byte identical to the input key (including leading/trailing spaces,
   `\n`, `…`, `·`, quotes inside the text). No extra keys, no missing keys.
2. **English is the source of truth.** The `zh` field is only a hint for what
   the UI is doing — do not translate from Chinese literally, and never leave
   Chinese characters in the output.
3. **Placeholders survive untouched:** `{count}`, `{name}`, `{percent}`,
   `{version}` … keep the same braces and the same identifier, and keep them
   where Vietnamese word order wants them.
4. **Keep formatting characters:** a string that is only punctuation,
   separators, symbols or a numeric format (`"·"`, `", "`, `"{percent}%"`,
   `"‑{count}"`, `"{n}% off"`) keeps those symbols. `…` becomes `…`.
   Preserve a trailing/leading space when the source has one.
5. **Technical tokens stay as-is:** `MCP`, `API`, `SDK`, `URL`, `JSON`, `DSH`,
   `DeepSeek`, `GitHub`, `OpenAI`, `Shell`, `Terminal`, `Bash`, `PowerShell`,
   `npm`, `pnpm`, model names (`V4-Pro`), file extensions, `localhost`, IPs,
   ports, slash commands (`/new`, `/compact`…), keyboard keys (`Ctrl`, `Enter`).
6. **Tone:** user-facing, neutral Vietnamese (standard/northern orthography).
   Buttons, menu items, labels and short status text are sentence case with
   **no trailing period**; full sentences/descriptions end with a period when
   the English does. Address the user as `bạn` when a person is meant.
   Keep it compact — UI space is tight; prefer the shorter of two good options.
7. **No English leftovers** unless the term is in the keep-list above or is a
   proper noun/id. Symbol-only and pure-format strings are the only entries
   where output may equal input.
8. **Don't invent product names.** "Session" is a DSH object (one chat thread),
   not a login session; "Agent" is the AI worker; "Subagent" is a child agent.
9. Escape correctly in JSON: newlines as `\n`, quotes as `\"`, backslashes as
   `\\`. The output must be valid JSON (UTF-8, no comments, no trailing commas).

## Glossary (use consistently)

| English | Vietnamese |
|---|---|
| Settings | Cài đặt |
| General | Chung |
| Language | Ngôn ngữ |
| Appearance / Theme | Giao diện |
| Light / Dark / System | Sáng / Tối / Theo hệ thống |
| Session | Phiên |
| Workspace | Không gian làm việc |
| Agent | Tác nhân |
| Subagent | Tác nhân con |
| Team / Agent Team | Nhóm / Nhóm tác nhân |
| Model | Mô hình |
| Provider | Nhà cung cấp |
| Plugin | Tiện ích |
| Bundle | Gói |
| Command | Lệnh |
| Slash command | Lệnh gạch chéo |
| Tool | Công cụ |
| Skill | Kỹ năng |
| Goal | Mục tiêu |
| Plan | Kế hoạch |
| Workflow | Quy trình |
| Job / Background job | Tác vụ nền |
| Trajectory | Nhật ký thực thi |
| Conversation | Hội thoại |
| Chat | Trò chuyện |
| Message | Tin nhắn |
| Prompt | Lời nhắc |
| Reasoning | Suy luận |
| Context | Ngữ cảnh |
| Token | Token |
| Attachment | Tệp đính kèm |
| File | Tệp |
| Folder / Directory | Thư mục |
| Path / Working directory | Đường dẫn / Thư mục làm việc |
| Search | Tìm kiếm |
| Reference | Tham chiếu |
| Permission | Quyền |
| Approval | Phê duyệt |
| Sandbox | Hộp cát |
| Account | Tài khoản |
| Credential / Key | Thông tin xác thực / Khóa |
| Sign in / Sign out | Đăng nhập / Đăng xuất |
| Deliverable | Sản phẩm bàn giao |
| Feedback | Phản hồi |
| Notification | Thông báo |
| Memory | Bộ nhớ |
| Storage | Lưu trữ |
| Checkpoint | Điểm kiểm tra |
| Compact (context) | Nén |
| Retry | Thử lại |
| Reload | Tải lại |
| Refresh | Làm mới |
| Save | Lưu |
| Cancel | Hủy |
| Close | Đóng |
| Open | Mở |
| Copy | Sao chép |
| Paste | Dán |
| Cut | Cắt |
| Undo / Redo | Hoàn tác / Làm lại |
| Delete / Remove | Xóa / Gỡ bỏ |
| Edit | Chỉnh sửa |
| Rename | Đổi tên |
| Add / Create / New | Thêm / Tạo / Mới |
| Enable / Disable | Bật / Tắt |
| On / Off | Bật / Tắt |
| Connected / Disconnected | Đã kết nối / Mất kết nối |
| Connecting / Reconnecting | Đang kết nối / Đang kết nối lại |
| Loading | Đang tải |
| Sending / Submitting | Đang gửi |
| Running / Stopped | Đang chạy / Đã dừng |
| Waiting | Đang chờ |
| Completed / Failed | Hoàn tất / Thất bại |
| Warning / Error | Cảnh báo / Lỗi |
| Expand / Collapse | Mở rộng / Thu gọn |
| Show / Hide | Hiện / Ẩn |
| More / Less | Thêm / Bớt |
| Back / Next / Done | Quay lại / Tiếp theo / Xong |
| Version | Phiên bản |
| Update / Upgrade | Cập nhật / Nâng cấp |
| Download / Upload | Tải xuống / Tải lên |
| Export / Import | Xuất / Nhập |
| Copy link / Copied | Sao chép liên kết / Đã sao chép |
| Keyboard shortcut | Phím tắt |
| Default | Mặc định |
| Custom | Tùy chỉnh |
| Advanced | Nâng cao |

## Calibration examples

| English | Vietnamese |
|---|---|
| `Settings` | `Cài đặt` |
| `Open settings` | `Mở cài đặt` |
| `New session` | `Phiên mới` |
| `Current version: {version}` | `Phiên bản hiện tại: {version}` |
| `Delete this session?` | `Xóa phiên này?` |
| `"{count} files changed"` | `"{count} tệp đã thay đổi"` |
| `Could not check for updates. Check your connection and try again.` | `Không thể kiểm tra cập nhật. Hãy kiểm tra kết nối và thử lại.` |
| `Search…` | `Tìm kiếm…` |
| `No results` | `Không có kết quả` |
| `Copy code` | `Sao chép mã` |
| `Thinking…` | `Đang suy nghĩ…` |
| `{percent}%` | `{percent}%` |
| `·` | `·` |
| `Waiting for approval` | `Đang chờ phê duyệt` |
| `3 more lines` | `3 dòng nữa` |
| `DeepSeek V4 Pro` | `DeepSeek V4 Pro` |
| `MCP server` | `Máy chủ MCP` |
| `API key` | `Khóa API` |

Write `translations/vi-NN.json` only (same NN as your packet), then report:
entry count, any entry you were unsure about, and confirm placeholders are
intact.
