import type { Metadata } from 'next';
import CameraView from './CameraView';

export const metadata: Metadata = { title: '101 — Camera on this page', description: 'Choose a camera for a small local preview, review available settings separately, and stop whenever you are done.' };
export default function CameraPage() { return <CameraView />; }
