import type { Metadata } from 'next';
import InspectorLab from './InspectorLab';

export const metadata: Metadata = {
  title: '101 SDK Inspector — Local runtime diagnostics',
  description: 'Inspect SDK resources, route authority, bounded queues and redacted errors in a local developer runtime.',
};

export default function InspectorPage() { return <InspectorLab />; }
