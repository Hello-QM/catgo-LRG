/**
 * 中文 — 移动端 UI 文本 (src/lib/mobile/*)。
 *
 * 覆盖移动端工作区：入口选择、顶部操作栏、SSH 连接表单、OTP 对话框、
 * SSH 密钥引导、远程文件浏览器以及只读文件查看器。
 * 通过 `load_i18n_module('mobile')` 按需加载。
 */

const mobile: Record<string, string> = {
  // ── 入口选择 (MobileWorkspace) ───────────────────────────────────────
  choose_prompt: `你想做什么？`,
  choice_structure_main: `查看 / 编辑结构`,
  choice_structure_desc: `打开本地文件 — 无需连接集群`,
  choice_database_main: `从数据库导入`,
  choice_database_desc: `搜索 OPTIMADE / Materials Project / PubChem`,
  choice_connect_main: `连接到集群`,
  choice_connect_desc: `SSH 终端 + 远程文件`,
  connect_app_only: `请用 CatGo App 使用终端 — 浏览器无法建立 SSH 连接`,

  // ── 顶部操作栏 (MobileWorkspace) ─────────────────────────────────────
  tab_structure: `结构`,
  tab_split_stacked: `分屏（上下）`,
  tab_split_side: `分屏（左右）`,
  tab_terminal: `终端`,
  action_remote_files: `远程文件`,
  action_open_local: `打开本地文件`,
  action_import_database: `从数据库导入`,
  action_save_structure: `保存结构`,
  action_disconnect: `断开连接`,
  // 顶部操作栏图标下方的简短标签
  action_remote_files_short: `文件`,
  action_open_local_short: `打开`,
  action_import_database_short: `数据库`,
  action_save_structure_short: `保存`,
  action_disconnect_short: `断开`,

  // ── 结构面板 (MobileWorkspace) ───────────────────────────────────────
  no_structure_loaded: `未加载结构。`,
  open_local_file: `打开本地文件`,
  open_from_cluster: `从集群打开`,

  // ── 保存 / 提示 (MobileWorkspace) ────────────────────────────────────
  could_not_parse: `无法将 {filename} 解析为结构。`,
  saved_to: `已保存到 {path}`,
  save_failed_reason: `保存失败：{reason}`,
  downloaded: `已下载 {filename}`,
  remote_files_title: `远程文件`,

  // ── 连接表单 (MobileConnect) ─────────────────────────────────────────
  connect_title: `连接到集群`,
  saved_label: `已保存`,
  new_connection: `+ 新建`,
  remove_saved_connection: `删除已保存的连接`,
  field_name: `名称（可选）`,
  field_name_placeholder: `Expanse`,
  field_host: `主机`,
  field_host_placeholder: `login.cluster.edu`,
  field_port: `端口`,
  field_username: `用户名`,
  field_auth_method: `认证方式`,
  method_password: `密码`,
  method_publickey: `公钥`,
  method_keyboard: `键盘交互`,
  field_password: `密码`,
  field_private_key_path: `私钥路径`,
  key_file_imported: `已选择私钥：{name}。仅用于本次连接，不会保存。`,
  field_passphrase: `私钥口令（可选）`,
  keyboard_hint: `连接后系统会提示你输入所需的验证码。`,
  use_jump_host: `使用跳板机 (ProxyJump)`,
  connecting: `连接中…`,
  connect_action: `连接`,
  connection_failed: `连接失败。`,
  saved_pw_rejected: `已保存的密码被拒绝 — 可能已更改。请重新输入以连接。`,
  auth_cancelled: `认证已取消。`,

  // ── 保存密码提示 (MobileConnect) ─────────────────────────────────────
  save_pw_title: `保存此集群的密码？`,
  save_pw_body:
    `下次连接到 {user} 时，你只需输入一次性验证码（OTP）。密码会加密保存在本设备上。`,
  save_pw_not_now: `暂不`,
  save_pw_save: `保存密码`,
  save_pw_retry: `重试`,
  save_pw_failed: `无法保存密码 — 未能存储。请重试，或继续并下次手动输入。`,

  // ── OTP 对话框 (OtpDialog) ───────────────────────────────────────────
  otp_title: `需要验证`,
  otp_cancel: `取消`,
  otp_submit: `提交`,
  otp_submitting: `提交中…`,

  // ── 免密登录引导 (KeySetup) ──────────────────────────────────────────
  ks_aria: `设置免密登录`,
  ks_title: `设置免密登录？`,
  ks_body:
    `在本设备生成一个 SSH 密钥并安装到 {user}。以后连接即可使用密钥而非密码。私钥在设备本地生成并加密存储 — 永远不会以未加密形式离开你的手机。`,
  ks_generating: `正在本设备生成密钥…`,
  ks_installing: `正在将公钥安装到 {host}…`,
  ks_storing: `正在本设备安全存储私钥…`,
  ks_done: `免密登录已设置完成。`,
  ks_close: `关闭`,
  ks_not_now: `暂不`,
  ks_try_again: `重试`,
  ks_working: `处理中…`,
  ks_set_up: `设置`,

  // ── 文件浏览器 (MobileFiles) ─────────────────────────────────────────
  loading: `加载中…`,
  empty_directory: `空目录`,
  parent: `上级`,
  path_placeholder: `跳转到路径…  /home/{user}/project`,
  go: `跳转`,
  aria_path: `路径`,
  aria_refresh: `刷新`,

  // ── 文件查看器 (MobileFileViewer) ────────────────────────────────────
  back: `返回`,
  back_to_files: `返回文件列表`,
  binary_file: `二进制文件`,
  binary_note: `{size} — 不显示（非文本或过大无法预览）。`,
  truncated_note: `仅显示前 {size} — 文件更大，已被截断。`,
  save: `保存`,
  saving: `保存中…`,
  saved: `已保存`,
  save_failed: `保存失败`,

  // ── 终端标签（MobileWorkspace「终端」面板）───────────────────────────
  term_panel: `终端`,
  term_label: `终端 {n}`,
  term_new: `新建终端`,
  term_add_where: `在哪个集群新建终端…`,
  term_add_new_cluster: `连接新集群…`,
  connected_label: `已连接集群`,
  connected_current: `当前`,
  connected_eject: `断开此集群`,
  term_close: `关闭终端`,
  term_edit: `编辑终端`,

  // ── AI 对话 (MobileChat / MobileChatSetup) ───────────────────────────
  action_ai: `AI 助手`,
  action_ai_short: `AI`,
  ai_title: `AI`,
  ai_provider: `提供方`,
  ai_setup: `AI 设置`,
  ai_setup_subtitle: `使用你自己的 API 密钥 — 已在本机加密存储，绝不上传。`,
  ai_api_key: `API 密钥`,
  ai_api_key_placeholder: `粘贴你的 API 密钥`,
  ai_key_saved: `已保存 API 密钥`,
  ai_replace_key: `替换`,
  ai_test_connection: `测试连接`,
  ai_testing: `测试中…`,
  ai_test_ok: `连接成功`,
  ai_base_url: `基础 URL`,
  ai_base_url_placeholder: `https://host/v1`,
  ai_model: `模型（可选）`,
  ai_save: `保存`,
  ai_saving: `保存中…`,
  ai_send: `发送`,
  ai_new_chat: `新对话`,
  ai_minimize: `最小化`,
  ai_close_chat: `关闭对话`,
  ai_stop: `停止`,
  ai_thinking: `思考中…`,
  ai_empty: `关于你的结构或研究，尽管问我。`,
  ai_no_key: `添加 API 密钥即可开始对话。`,
  ai_invalid_key: `API 密钥无效。请在 AI 设置中检查密钥。`,
  ai_rate_limited:
    `已达到速率限制 — 免费层每分钟只能发送少量消息。请等待几秒后重试，或在设置中选择额度更高的模型。`,
  ai_model_busy:
    `模型当前繁忙（需求高峰）— 通常是暂时的。请稍候重试，或在设置中尝试其他模型。`,
  ai_message_placeholder: `输入消息…`,
  ai_tool_permission: `CatBot 请求执行工具`,
  ai_allow: `允许`,
  ai_deny: `拒绝`,
  ai_dont_ask_again: `本会话内不再询问`,
  ai_tool_failed: `失败`,
}

export default mobile
