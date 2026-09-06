import type { Metadata } from "next";

import InputLabRoute from "./InputLabRoute";

export const metadata: Metadata = {
  title: "101 Input Lab — See every source at once",
  description: "Watch keyboard, pointer, touch, gamepad and linked devices resolve into one shared input frame.",
};

export default function InputPage() {
  return <InputLabRoute />;
}
