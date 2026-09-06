import type { Metadata } from "next";
import ControllerLab from "./ControllerLab";

export const metadata: Metadata = {
  title: "101 Controller Lab — Dynamic Link layouts",
  description: "Validate custom controller JSON, apply it live to 101 Link, and inspect normalized input frames.",
};

export default function ControllerLabPage() {
  return <ControllerLab />;
}
