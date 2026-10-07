import type { Metadata } from 'next';
import GamepadView from './GamepadView';

export const metadata: Metadata = { title: '101 — Check a gamepad here',
  description: 'Choose one gamepad, review its brief local use, check reported inputs and stop.' };
export default function GamepadPage() { return <GamepadView />; }
