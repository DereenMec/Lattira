import { useEffect, useState } from "react";
import { backend } from "@/services/backend";
import { useAppStore } from "@/store/appStore";
import type { Asset } from "@/types/model";

const cached = new Map<string, Promise<string>>();
const queue: (() => void)[] = [];
let running = 0;
function next() { while (running < 3 && queue.length) queue.shift()!(); }
function thumbnail(asset: Asset, key: string) {
  let pending = cached.get(key);
  if (!pending) {
    pending = new Promise<string>((resolve) => {
      queue.push(() => {
        running++;
        backend.thumbnailAsset(asset).then(resolve, () => resolve(backend.assetUrl(asset))).finally(() => { running--; next(); });
      }); next();
    });
    cached.set(key, pending);
    if (cached.size > 1000) cached.delete(cached.keys().next().value!);
  }
  return pending;
}
export function AssetImage({ asset, className = "", alt = "" }: { asset: Asset; className?: string; alt?: string }) {
  const workspace = useAppStore((s) => s.workspace?.path);
  const key = `${workspace}:${asset.id}:${asset.hash}`;
  const [result, setResult] = useState<{ key: string; url: string }>();
  useEffect(() => {
    let alive = true;
    void thumbnail(asset, key).then((url) => { if (alive) setResult({ key, url }); });
    return () => { alive = false; };
  }, [key]);
  return result?.key === key && result.url ? <img className={className} src={result.url} alt={alt} loading="lazy" decoding="async" draggable={false} /> : <span className={className} aria-label={alt} />;
}
