import type { Metadata } from "next";
import VisionLab from "./VisionLab";

export const metadata: Metadata = {
  title: "101 Vision Lab — Local body and hand tracking",
  description: "Run bundled MediaPipe pose or hand tracking locally and inspect normalized 101 actions without uploading video.",
};

export default function VisionPage() {
  return <VisionLab />;
}
