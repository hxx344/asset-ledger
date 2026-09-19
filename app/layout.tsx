import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title:'资产统计 · 个人资产账本', description:'资产估值、历史记录与交易所只读同步。', icons:{icon:'/favicon.svg',shortcut:'/favicon.svg'} };
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="zh-CN"><body>{children}</body></html>;}
