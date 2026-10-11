/**
 * 名字不重复的规则（与 Windows 资源管理器一致）：比较时去掉首尾空白、不区分大小写；
 * 需要自动起名时用「名字 (2)」，就地复制时用「名字_副本」「名字_副本 (2)」，扩展名保持在最后。
 */

export const nameKey = (name: string) => name.trim().toLowerCase();

export const sameName = (a: string, b: string) => nameKey(a) === nameKey(b);

/** 文件名拆成主名和扩展名（含点）；文件夹、项目、画布没有扩展名 */
export function splitName(name: string, hasExt: boolean): [string, string] {
  const dot = name.lastIndexOf(".");
  return hasExt && dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

export interface UniqueNameOptions {
  /** 是文件名（扩展名留在最后） */
  ext?: boolean;
  /** number：名字 (2)；copy：名字{suffix}、名字{suffix} (2) */
  style?: "number" | "copy";
  /** copy 风格加在主名后面的文字，如「_副本」 */
  suffix?: string;
}

/** 不和 taken（已被占用的名字，见 nameKey）冲突的名字；name 本身没被占用时原样返回（copy 风格总会加后缀） */
export function uniqueName(name: string, taken: ReadonlySet<string>, opts: UniqueNameOptions = {}): string {
  const [stem, ext] = splitName(name.trim(), !!opts.ext);
  const base = opts.style === "copy" ? `${stem}${opts.suffix ?? ""}` : stem;
  for (let n = 1; ; n++) {
    if (n === 1 && opts.style !== "copy" && !taken.has(nameKey(name))) return name.trim();
    const candidate = `${n === 1 ? base : `${base} (${n})`}${ext}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}
