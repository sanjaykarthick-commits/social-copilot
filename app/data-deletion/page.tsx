import type { Metadata } from "next";
import { Contact, LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Data deletion" };

export default async function DataDeletionPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const { code } = await searchParams;
  const safeCode = code && /^[a-f0-9]{8,64}$/.test(code) ? code : null;
  return (
    <LegalPage title="Data deletion" updated="October 27, 2026">
      {safeCode && (
        <p className="bg-muted rounded-xl p-4">
          Your deletion request <span className="font-mono">{safeCode}</span> has been completed: the Instagram connection, its tokens and its comments were
          removed from Social Copilot.
        </p>
      )}
      <h2>Delete a connected account</h2>
      <p>Open Accounts in Social Copilot and choose Disconnect. The account&apos;s tokens are deleted immediately and nothing is published to it again.</p>
      <h2>Instagram</h2>
      <p>
        You can also remove Social Copilot in Instagram (Settings → Website permissions → Apps and websites). If you send a data deletion request through Meta,
        we delete the connection, its tokens and the comments we stored for it as soon as the request arrives.
      </p>
      <h2>Delete everything</h2>
      <p>
        To delete your Social Copilot account and all of its data, write to <Contact /> from the email address you signed up with.
      </p>
    </LegalPage>
  );
}
