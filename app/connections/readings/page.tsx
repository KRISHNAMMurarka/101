import type { Metadata } from 'next';
import ReadingsView from './ReadingsView';

export const metadata: Metadata = { title: '101 — View shared readings',
  description: 'Choose readings from another page, allow sharing on both pages, and stop when you are done.' };
export default function ReadingsPage() { return <ReadingsView />; }
