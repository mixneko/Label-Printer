/** 關閉程式前的三選一對話框：儲存並關閉／取消／放棄儲存並關閉（後者用紅色強調）。 */
export type CloseChoice = "save" | "cancel" | "discard";

export function askClose(message: string): Promise<CloseChoice> {
  const dlg = document.getElementById("close-dialog") as HTMLDialogElement;
  document.getElementById("close-msg")!.textContent = message;
  return new Promise((resolve) => {
    let choice: CloseChoice = "cancel"; // Esc 或點到外面都視為取消
    const pick = (c: CloseChoice) => () => { choice = c; dlg.close(); };
    const save = document.getElementById("close-save")!;
    const cancel = document.getElementById("close-cancel")!;
    const discard = document.getElementById("close-discard")!;
    const onSave = pick("save"), onCancel = pick("cancel"), onDiscard = pick("discard");
    save.addEventListener("click", onSave);
    cancel.addEventListener("click", onCancel);
    discard.addEventListener("click", onDiscard);
    dlg.addEventListener("close", () => {
      save.removeEventListener("click", onSave);
      cancel.removeEventListener("click", onCancel);
      discard.removeEventListener("click", onDiscard);
      resolve(choice);
    }, { once: true });
    dlg.showModal();
    save.focus(); // 預設焦點放在最安全的「儲存並關閉」
  });
}
