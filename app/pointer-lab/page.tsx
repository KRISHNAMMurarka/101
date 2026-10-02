import type { Metadata } from 'next';
import PointerLab from './PointerLab';
export const metadata: Metadata = { title: '101 Pointer lab', description: 'A local touch source and independent application surface using typed resources.' };
export default function PointerPage() { return <PointerLab />; }
