import { BRAND_NAME } from "@/brand";

export function BanRiskNotice() {
  return (
    <aside
      className="border border-[#e8c9a8] bg-[#fff7ee] p-4 text-sm text-warn dark:border-[#5a3d1a] dark:bg-[#2a1f10]"
      role="note"
    >
      <p className="font-medium text-ink dark:text-[#f0c48a]">Ban risk</p>
      <p className="mt-1 text-muted dark:text-[#d4b07a]">
        {BRAND_NAME} uses an unofficial WhatsApp connection. Linking a number can lead to
        temporary or permanent bans. Do not spam, respect WhatsApp&apos;s terms, and prefer a
        secondary number for testing.
      </p>
    </aside>
  );
}
