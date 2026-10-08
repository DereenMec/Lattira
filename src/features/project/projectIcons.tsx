import {
  Book,
  Bookmark,
  Briefcase,
  Camera,
  Code,
  Coffee,
  Dumbbell,
  Film,
  Flag,
  FlaskConical,
  Folder,
  Gamepad2,
  GraduationCap,
  Heart,
  House,
  Leaf,
  Lightbulb,
  Music,
  Palette,
  PenTool,
  Plane,
  Rocket,
  ShoppingCart,
  Star,
  Target,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { msg } from "@/i18n";
import type { Project } from "@/types/model";

/** 可选的项目图标；键名存进数据库，改名会让已选的图标失效 */
export const PROJECT_ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  folder: { icon: Folder, label: msg("文件夹") },
  star: { icon: Star, label: msg("星标") },
  heart: { icon: Heart, label: msg("喜欢") },
  bookmark: { icon: Bookmark, label: msg("书签") },
  book: { icon: Book, label: msg("阅读") },
  graduation: { icon: GraduationCap, label: msg("学习") },
  briefcase: { icon: Briefcase, label: msg("工作") },
  users: { icon: Users, label: msg("团队") },
  target: { icon: Target, label: msg("目标") },
  flag: { icon: Flag, label: msg("里程碑") },
  rocket: { icon: Rocket, label: msg("项目") },
  lightbulb: { icon: Lightbulb, label: msg("灵感") },
  code: { icon: Code, label: msg("代码") },
  wrench: { icon: Wrench, label: msg("工具") },
  flask: { icon: FlaskConical, label: msg("研究") },
  palette: { icon: Palette, label: msg("设计") },
  pen: { icon: PenTool, label: msg("创作") },
  camera: { icon: Camera, label: msg("摄影") },
  film: { icon: Film, label: msg("影视") },
  music: { icon: Music, label: msg("音乐") },
  gamepad: { icon: Gamepad2, label: msg("游戏") },
  plane: { icon: Plane, label: msg("旅行") },
  house: { icon: House, label: msg("生活") },
  cart: { icon: ShoppingCart, label: msg("购物") },
  wallet: { icon: Wallet, label: msg("财务") },
  dumbbell: { icon: Dumbbell, label: msg("健身") },
  coffee: { icon: Coffee, label: msg("日常") },
  leaf: { icon: Leaf, label: msg("自然") },
};

/** 预设颜色，另外还可以用取色器选任意颜色 */
export const PROJECT_PALETTE = [
  "#2F5D50", "#0E7490", "#2563EB", "#4338CA", "#7C3AED", "#9D174D",
  "#DB2777", "#DC2626", "#C2410C", "#B45309", "#CA8A04", "#4D7C0F",
  "#15803D", "#0F766E", "#475569", "#78716C",
];

/** 项目标识：选了图标就画图标，否则画圆点，都使用项目颜色 */
export function ProjectIcon({ project, size = 15 }: { project: Pick<Project, "color" | "icon">; size?: number }) {
  const entry = project.icon ? PROJECT_ICONS[project.icon] : undefined;
  if (!entry) {
    const d = Math.round(size * 0.62);
    return <span className="dot" style={{ background: project.color, width: d, height: d }} />;
  }
  const Icon = entry.icon;
  return <Icon size={size} color={project.color} strokeWidth={2.2} className="project-icon" />;
}
