import { redirect } from "next/navigation";

/* The LoRA library moved into the Library page. */
export default function LorasRoute() {
  redirect("/library");
}
