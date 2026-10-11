/** Blob bodies live in IndexedDB; object URLs are recreated after a page reload. */
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("lattira.files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
export async function storeFile(id: string, blob: Blob): Promise<void> {
  const transaction = (await db()).transaction("files", "readwrite");
  transaction.objectStore("files").put(blob, id);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("文件保存失败"));
    transaction.onerror = () => reject(transaction.error);
  });
}
export async function loadFile(id: string): Promise<Blob | undefined> {
  const request = (await db()).transaction("files").objectStore("files").get(id);
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function removeFile(id: string): Promise<void> {
  const transaction = (await db()).transaction("files", "readwrite");
  transaction.objectStore("files").delete(id);
  await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error); });
}
