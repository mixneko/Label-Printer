// 先套用使用者選的外觀，避免開啟時閃一下（theme.ts 之後接手按鈕與儲存）。
// 放成獨立檔案而不是行內 <script>，這樣內容安全政策（CSP）不必允許行內腳本。
try { var t = localStorage.getItem("label-printer.theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); } catch (e) {}
