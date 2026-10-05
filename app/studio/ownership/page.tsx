import type { Metadata } from 'next';
import OwnershipLab from './OwnershipLab';

export const metadata: Metadata = { title: '101 Input ownership', description: 'Review local input requests, transfers, partition assignment and release.' };
export default function OwnershipPage() { return <OwnershipLab />; }
