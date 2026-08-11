import type { Metadata } from "next";
import VisionLab from "./VisionLab";

export const metadata: Metadata = {
  title: "101 Vision Lab — Local body tracking",
  description: "Run bundled MediaPipe pose tracking locally and inspect normalized 101 body actions without uploading video.",
};

export default function VisionPage() {
  return <VisionLab />;
}
