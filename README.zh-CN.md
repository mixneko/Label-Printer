# Label Printer

[繁體中文](README.md) · [English](README.en.md) · **简体中文** · [Español](README.es.md) · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

取代 BarTender Designer 的轻量标签排版与打印软件。目标打印机：TSC TTP-244 Pro（203 dpi，TSPL2），可通过 Windows 已安装的打印机（RAW）打印，也可经由 print server 以 Raw TCP 直接打印。

技术：Tauri 2（Rust 后端）+ TypeScript + Konva.js（画布编辑器）。

## 开发环境（Windows）

1. [Node.js LTS](https://nodejs.org/)
2. [Rust](https://rustup.rs/)（需要 MSVC：安装 Visual Studio Build Tools 的“使用 C++ 的桌面开发”）
3. WebView2 Runtime（Windows 11 已内置）

```powershell
npm install
npm run tauri icon app-icon.png   # 只需第一次：生成 src-tauri/icons
npm run tauri dev                 # 开发模式
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单元测试
```

## 打包与部署

```powershell
npm run tauri build
```

产出：

- `src-tauri/target/release/Label Printer.exe`：单一可执行文件，复制即可使用（需要 WebView2，Win11 已内置）。
- `src-tauri/target/release/bundle/nsis/*-setup.exe`：安装包，内嵌 WebView2 引导程序，Win10 也能安装；安装到当前用户，不需要管理员权限。

## 自动更新

安装版启动时会在后台向 GitHub 查询一次是否有新版（只读取公开的版本信息，不发送任何数据）；有新版就弹出窗口，点“立即更新”即可在程序内下载、验证签名、安装并自动重启。可在“帮助 → 启动时自动检查更新”关闭，也可随时用“帮助 → 检查新版本”手动检查。免安装版无法原地更新，会改为打开下载页面。

维护者：发布流程（`.github/workflows/release.yml`）需要仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`（更新签名私钥，由 `tauri signer generate` 生成；公钥在 `src-tauri/tauri.conf.json`）。丢失私钥就无法再向旧版用户推送更新。

## 架构

- 前端把标签渲染为 1-bit 点阵，后端转成 TSPL（`SIZE/GAP/BITMAP/PRINT`）。
- 默认经 Windows 假脱机以 **RAW** 数据类型发送到已安装的打印机（驱动不做转换，TSPL 原样送出）；也可切换为直连 Raw TCP（如 `192.168.1.100:9103`）。
- 字体使用 Windows 系统已安装的字体（WebView2 读取 `C:\Windows\Fonts` 与用户字体），换电脑时该电脑也需要安装同样的字体。
- 纸张 62.5×30 mm、标签 60×30 mm，均可在界面中调整；标签会居中于纸张。
- 标签文字可使用 `{{字段}}` 变量（Excel 的列标题）。打印张数 = 在数据表中勾选的行数。

## 示例文件（`samples/`）

- `範例標籤.lpxl` + `範例貨品清單.csv`：虚构的 60×30 mm 货品标签与对应数据（字段：品名、编号、批号、效期），演示变量、二维码、条码、日期格式与文字“最大范围”（品名过长会自动缩小）。
- `商品清單.xlsx`（两个工作表）、`商品清單-big5.csv`：用于测试导入。
- 重新生成 xlsx / csv 示例：`cargo run --manifest-path src-tauri/Cargo.toml --example make_samples`

## 路线图

- [x] 项目骨架、文字对象、打印
- [x] 条码 / 二维码 / 图片 / 线条 / 矩形对象、字体下拉菜单（系统已安装字体）
- [x] 标签的保存与加载
- [x] 本机 Excel / CSV 数据源（工具栏“选择数据源”）、批量打印、预览（第一行为字段标题，其后每一行是一条数据；在表格中勾选哪几行就打印几张，标签上的 `{{字段}}` 取自该行。Excel 不需要“份数”列；支持 .xlsx/.xlsm/.xls 与 .csv，CSV 自动判断 UTF-8 / Big5 与分隔符）
- [x] 打印校正：浓度、速度、字体加粗、撕纸位置、额外送纸、位置左右/上下微调，以及“工具 → 生成校正标签”（外框与 mm 刻度）
- [x] 原生条码指令（`BARCODE` / `QRCODE`）：可选（默认关闭），在条码或二维码的属性中勾选“使用打印机原生指令打印”；内容含中文或对象旋转时自动改用点阵
- [ ] 应用程序信任：代码签名（Authenticode），降低 Windows SmartScreen 与杀毒软件的警告
- [x] 多语言：界面支持英文、西班牙文、德文、日文、韩文、简体中文、繁体中文；首次启动按系统语言选择，可通过菜单栏右上角的地球按钮切换；本 README 也有七种语言版本；翻译尚待母语者审阅

> 注意：TSPL `BITMAP` 的黑白位定义（0 = 打印）已在程序中取反处理，需以实机确认打印结果。

## 许可

本项目以 [MIT 许可](LICENSE) 发布。第三方软件包各自的许可声明见程序内“帮助 → 第三方许可声明”。
