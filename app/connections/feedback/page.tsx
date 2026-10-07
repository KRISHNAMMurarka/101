import type { Metadata } from 'next';
import FeedbackView from './FeedbackView';

export const metadata: Metadata = { title: '101 — Try feedback',
  description: 'Review page buttons and browser feedback separately, request one preset and stop.' };
export default function FeedbackPage() { return <FeedbackView />; }
