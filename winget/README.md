# winget（Windows 套件管理員）

讓使用者可以用 `winget install Mixneko.LabelPrinter` 安裝 Label Printer。

- `manifests/` 是送給 [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) 的安裝清單（資料夾結構和該倉庫一致）。
- 由 `node scripts/make-winget.mjs <版本>` 產生：從 GitHub Release 下載安裝檔、算出 SHA256 再寫出清單。只接受正式版版本號。
- 驗證：`winget validate --manifest winget/manifests/m/Mixneko/LabelPrinter/<版本>`

## 一次性設定（只需要做一次）

**1. 第一個版本要先手動送出。** winget 上還沒有這個套件時，自動更新沒有東西可以更新。

最簡單的做法是用 Microsoft 官方的 [wingetcreate](https://github.com/microsoft/winget-create)：

```powershell
winget install Microsoft.WingetCreate
wingetcreate submit --token <你的 PAT> winget/manifests/m/Mixneko/LabelPrinter/1.0.0
```

也可以自己 fork microsoft/winget-pkgs，把 `winget/manifests/` 底下的 `m` 資料夾放進該倉庫的 `manifests/`，再開 Pull Request。審查通常幾天內完成，審查機器人會實際安裝並掃描安裝檔。

**2. 建立權杖並設成 Secret。** 自動更新要用 PAT 來 fork winget-pkgs 並送 Pull Request：

1. GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token。
2. 只勾 **`public_repo`**（不要多勾）。有效期限建議 1 年，到期前換新。
3. 到這個倉庫的 Settings → Secrets and variables → Actions → New repository secret，名稱填 **`WINGET_TOKEN`**，貼上權杖。

> 權杖只放在 Secret 裡，不要貼進對話、檔案或 issue。

## 之後的版本（全自動）

推 `vX.Y.Z` 標籤後，`.github/workflows/release.yml` 會：建置 → 建立 Release → **`winget` 工作** 用 wingetcreate 向 winget-pkgs 送出更新的 Pull Request（網址與 SHA256 由 wingetcreate 算）。

- 帶 `-a`／`-b` 後綴的預發行版**不會**送 winget。
- 沒設定 `WINGET_TOKEN` 時，這個工作只顯示一則提示就結束，不影響發布。
- 送出失敗（例如套件還沒在 winget 上、權杖過期）只顯示警告，Release 不受影響。
- winget-pkgs 的審查是人工＋機器人，更新要等它合併後 `winget upgrade` 才看得到，通常是幾小時到幾天。
