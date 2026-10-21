# 离线办公工具 0.3.0 状态

更新时间:2026-10-21

## 当前状态

- `npm test`:**79/79 通过**。
- `npm run build`:**通过**。
- `npm run dist`:**通过**,产物 `release/离线办公工具-0.3.0-ia32-win.zip`(111,520,587 B,SHA-256 `b1bbe0bc5b6073246b2757cd2742323f0f5604856e30ae8da615afcb5c8d73f8`)。
- `scripts/acceptance.mjs` 的真实窗口验收:源码态 **37/37**、本地解包 exe **37/37**、云端 Release 资产解包后 **37/37**,均包含 3 个压力场景。
- 已发布 `v0.3.0`(commit `32a6a14`,tag `v0.3.0`):https://github.com/KongValley/OfflineOfficeTools/releases/tag/v0.3.0
  - 云端资产 `OfflineOfficeTools-0.3.0-ia32-win.zip`,111,520,550 B,SHA-256 `DDED941EE51753D621873437149329393CA37A02F28DCA01F5C82946163DB968`。
  - CI 运行 `39522558632`:zip 条目 75、原生 0、`e_machine=0x014c`;asar 条目 3816,含 `imageOps.js`/`fileOps.js`/`jpeg-js`。
  - 本地包与云端包因 ZIP 时间戳/图标写入路径不同,SHA 不同,属正常。

## P0 功能验收(自动化覆盖)

已由 `node scripts/acceptance.mjs`(源码态)与 `node scripts/acceptance.mjs --exe "release/win-ia32-unpacked/离线办公工具.exe" --stress`(解包态)各跑一遍:

### PDF 整理

- [x] 图片盖章:9 宫格、宽度 20/30%、透明度 0.5、角度 30°、边距 10/24,回读图片外接框与设置一致。
- [x] 图片盖章页码范围:`1,3-4` 只作用于第 1/3/4 页,其余页无图片。
- [x] JPG 签名盖章:输出可重开、页内有图片。
- [x] 插入 PDF 页面:第 1 页后插入 `1-2`,文本顺序为 `A X Y B C`。
- [x] 插入空白页:位置 0(A4)与末尾(同前一页),页数与尺寸正确。
- [x] 元数据:标题/作者/主题/关键词保存后回读;关键词从 `合同，2026;重要` 读回为 `合同 2026 重要`,界面显示 `合同, 2026, 重要`;清除后全空。
- [x] 拼版:2 合 1 A4 自动、4 合 1 Letter 纵向先列后行;页数、纸张、嵌入页数量与列优先顺序正确。
- [x] 统一页面尺寸:混合 A4/Letter/旋转页统一为 A4,尺寸、方向、嵌入框宽高比正确。
- [x] 带 `/Rotate 90` 的扫描件盖章:按可见页面右下定位,页面坐标宽高互换正确。
- [x] 带 CropBox 偏移的 PDF 盖章:印章外接框落在 CropBox 内。
- [ ] 打印预览确认拼版页序与方向(需真实打印对话框)。

### 图片工具

- [x] 压缩到 200 KB / 50 KB:输出不超过目标、可正常解码;透明 PNG 铺白。
- [x] 30MP 大图压缩:解包 ia32 实测 5.3 s、RSS 峰值 433 MB,不崩溃。
- [x] 裁剪:四边边距、1:1、一寸 295×413 像素精确,居中裁剪。
- [x] 拼长图:纵向 3 张(100×360)、小图不放大(100×240)、白底/间距正确。
- [x] 拼长图超限:宽度 20000 时明确报错且不写文件。
- [x] 文字水印:中文「内部资料」、红色、居中、35%、45° 不平铺;输出像素确实变化。
- [x] 文字水印批次:两张不同尺寸图各自输出 `_水印` 文件。
- [x] 回归:右旋 90°、缩放 50%、转 JPEG、合成 PDF 各一次。

### 文件工具

- [x] 选择 2 个文件,前缀+序号+新扩展名,预览与磁盘结果一致。
- [x] 执行重命名后内容不变。
- [x] 撤销上次重命名;重启应用后仍可撤销最近一次(验收脚本会备份/还原真实 `last-rename.json`)。
- [x] 仅大小写改名 `a.txt → A.txt`。
- [x] 冲突:目标已存在时拒绝,源文件保留。
- [x] 非法名 `CON.txt`、`a:b.txt`、结尾点:按钮禁用并提示「需要修正」。
- [ ] 原生「打开/另存为/选择目录」对话框真实点选(脚本用 IPC 桩替代)。
- [ ] 拖放导入(File/Image/PDF/Text)人工各一次。

### 文本 / Markdown / 小工具

- [x] GBK 文件:编码识别、统计数字、前后缀、行号(空行不占号)、大小写、全角、去行首尾空白;输出仍为 GBK + CRLF。
- [x] 8MB 文本:真实按键插入(execCommand)后统计计算约 0.36–0.4 s,从按键到统计刷新约 1.2 s;先前约 3.4 s 是脚本整块重写 `textarea.value` 的测量假象,不是真实键入开销。
- [x] Markdown 目录:插入/更新后预览锚点可滚动跳转,导出 HTML 的目录 href 与标题 id 一一对应,front matter 与围栏代码里的 `#` 不生成条目。
- [x] Markdown 导出 PDF:非空且含标题与目录文字。
- [ ] PDF 内目录锚点是否可点击(Chromium 108 `printToPDF` 已知风险,需人工确认)。
- [x] 单位换算:长度/面积/重量/体积/温度(C→F、C→K)/存储各一组,结果与纯函数一致。
- [x] 文件校验:MD5/SHA-1/SHA-256 与 Node `crypto` 一致。

## P1 发布前

- [x] 内存压力:30MP 压缩 5.3 s / RSS 433 MB;30 张拼长图 2.4 s / 200 MB;约 190MB PDF 加页码另存 2.9 s / 314 MB(均为解包 ia32 实测)。
- [x] `npm run dist` 本地出 ia32 zip,解包后跑完整 P0 自动化清单。
- [ ] 真实 Win7 32 位机器:启动、拖放、对话框、另存为、新按钮全部人工确认。
- [x] 包内无 `canvas` / `*.node`(asar 条目 3816,原生 0)。
- [x] `src/main/imageOps.js`、`fileOps.js`、`dist/renderer/index.html` 均在 asar 内;`e_machine=0x014c`。
- [x] 已发布:commit `32a6a14`、tag `v0.3.0`;云端 CI 出包并挂到 Release,资产 SHA-256 `DDED941E…DB968`,下载解包后自动化验收 37/37。

## P2 边界与加固

- [x] `mdToc.insertOrUpdateToc`:孤立起始标记会连同遗留目录一起替换,孤立结束标记会删除;成对标记仍幂等。
- [x] 元数据关键词按空白/逗号/分号拆分,`getKeywords()` 的空格串读取后再保存不会被合并;界面回填为逗号分隔。
- [x] 拼版/统一尺寸新增页码范围,留空为全部,非法范围有中文提示。
- [x] 图片盖章补偿页面 `/Rotate`:按可见方向定位与缩放,`widthPercent` 以可见页宽为基准。
- [x] `applyRenamePlan` 失败注入测试:暂存阶段与落位阶段各有回滚用例,验证无临时文件残留。
- [x] 拼长图新增「小图不放大(居中留白)」。
- [x] 30MP JPEG 解码:Jimp/jpeg-js 默认 512MB 预算会拒绝,已提高到 1024MB,超预算转中文提示;`jpeg-js` 已声明为直接依赖 0.4.4。
- [x] 目标 KB 压缩:先按目标大小降到工作像素(上限 1200 万)再搜索质量,避免 32 位进程反复整图编码耗尽 V8 堆;200KB 目标实测 5.3 s。
- [x] 文字水印字体依赖已写入 README 已知限制。
- [x] `tmp/` 调试脚本已清理;验收脚本成功结束时自动删除 `tmp/e2e`。

## 自动化验证

- `tests/pdfcompose.test.mjs`:拼版/统一尺寸页码范围、2/4/9 合 1、空白页跳过、插入页序、元数据回读(含关键词往返)、盖章(指定页/CropBox/`/Rotate`/透明度)。
- `tests/imageops.test.mjs`:裁剪、证件照、目标 KB、30MP 解码与目标压缩、拼长图(默认/不放大)、水印、超限报错。
- `tests/fileops.test.mjs`:两阶段互换、仅大小写、冲突拒绝、临时文件清理、撤销记录、三个哈希、两阶段失败回滚注入。
- `tests/mdtoc.test.mjs`:front matter、围栏代码、重复标题、TOC 幂等、孤立标记、标题 id 与目录 slug 一致。
- `tests/pdfLayout.test.mjs`:`/Rotate` 坐标映射、旋转外接框、9 宫格、拼版网格。
- `tests/textops.test.mjs`、`tests/units.test.mjs`、`tests/renamePlan.test.mjs`、`tests/pdfops.test.mjs` 原有覆盖保留。

## 常用命令

```bash
npm test          # 79 个用例
npm run build     # 渲染层构建
npm run dev       # 构建并启动桌面应用
npm run dist      # 本地 ia32 zip
node scripts/acceptance.mjs              # 源码态真实窗口验收(先 build)
node scripts/acceptance.mjs --exe "release/win-ia32-unpacked/离线办公工具.exe" --stress  # 解包态 + 压力
```

## 备注

- 验收脚本用主进程 inspector + `ipcMain.removeHandler/handle` 桩掉原生对话框,真实对话框点选、拖放、打印预览、PDF 页内锚点与 Win7 真机仍是人工项。
- 验收脚本会临时写入并还原用户数据目录里的 `last-rename.json`;不会改待办数据。
- 未改动的既有约束:Electron 22.3.27、Chromium 108、纯 JS 依赖、无原生模块、不升级 Vite 4。
