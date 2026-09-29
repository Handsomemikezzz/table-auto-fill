# 浏览器填写回归

执行 `npm run test:form-fill`，先构建扩展，再在独立浏览器临时用户目录中运行本地 React 表单。
已有最新 `dist` 时，可执行 `npm run test:form-fill:browser`。

测试分为两层：

- 浏览器直接调用填写引擎，检查真实 React 受控状态、编码反转、ARIA 控件、搜索未提交（含高亮建议）、延迟回滚、真实 Ant Design 日期/月控件、地区级联和用户中途编辑。
- 加载实际扩展，使用后台到 content script 的公开 `FILL_FORM` 消息，检查发现、资料绑定、执行、验证及 `verifiedCount`；教育经历用研究生在前、本科在后、研究生缺少毕业日期控件的布局。
- 验证用户编辑后的撤销保护、联动清空后的成功数修正、没有网站专属属性的起止时间组，以及 AI 页填在本地阶段终止后不再填写后续字段或上传附件。

测试只服务本地页面，使用合成个人资料；不会访问招聘网站或提交申请。状态断言同时检查 React state，避免仅改 DOM 就通过。失败用例必须保持 `verifiedCount = 0` 并返回失败项。

浏览器定位优先使用 `JOB_APPLYMATE_BROWSER_PATH`（或 `CHROME_PATH`），然后查找已有 Playwright Chromium 缓存和 macOS、Windows、Linux 常用安装路径。不会自动下载浏览器。需要观察界面时设置 `JOB_APPLYMATE_HEADED=1`。某些普通 Chrome 版本禁止命令行加载扩展，可指定已经安装的 Chrome for Testing / Chromium。

发布工作流安装固定版本 Chrome for Testing `143.0.7499.4`，构建后运行同一浏览器脚本，失败时阻止继续发布。调试某组用例可设置 `JOB_APPLYMATE_TEST_FILTER=级联`；正式验收应运行完整集合。

这些用例验证填写契约和插件整合，不代表真实招聘网站的 80% 覆盖率。后者需要独立人工标注、按招聘系统及组件实现留出的真实表单样本。不要把该测试页的通过率当跨站覆盖率。

日期专项可通过开发服务器打开 `/tests/form-fill/date-range-regression.html`，点击“运行日期回归”。它复现飞书系表单的深层共享 `start_end_time`、左右模块标题和失焦格式化，同时验证普通文本及日期精度保护。常规扩展回归也加入了同结构的 `feishu-deep-range` 用例。
