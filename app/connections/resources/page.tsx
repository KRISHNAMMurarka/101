import type { Metadata } from 'next';
import ResourceTaskView from './ResourceTaskView';

export const metadata: Metadata = { title: '101 — Connect page controls',
  description: 'Choose a page input and its output. Allow both, use them, and stop when you are done.' };
export default function ResourceTaskPage() { return <ResourceTaskView />; }
