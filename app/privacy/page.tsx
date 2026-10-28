import type { Metadata } from "next";
import { Contact, LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" updated="October 27, 2026">
      <p>
        Social Copilot lets you schedule posts to your own social accounts, see how they perform, and reply to comments on them. This page explains what data
        the service handles, why, and how you can remove it. Questions: <Contact />.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>Your sign-in details (name, email address, profile photo), handled by our authentication provider, Clerk.</li>
        <li>
          For each social account you connect (Instagram, YouTube, LinkedIn, X): the account id, name, username and profile photo, and the access tokens the
          platform issues. Tokens are encrypted (AES-256-GCM) before they are stored and are never shown in the browser.
        </li>
        <li>The posts you write and schedule, the photos and videos you upload for them, and their schedule and publishing results.</li>
        <li>Engagement numbers the platforms report for your posts (likes, comments, views).</li>
        <li>Comments other people leave on your posts (their public name or username, profile photo, text and time), so you can read and answer them here, and the replies you send.</li>
        <li>Your settings, such as your timezone.</li>
      </ul>

      <h2>How we use it</h2>
      <p>
        Only to provide the service you asked for: publishing your posts at the time you choose, showing your calendar and statistics, and showing and sending
        comment replies. We do not sell your data, use it for advertising, or use it to train AI models.
      </p>

      <h2>Who else receives it</h2>
      <ul>
        <li>The platforms you publish to, which receive the posts, media and replies you send them.</li>
        <li>
          Service providers that run the app for us: Clerk (sign-in), our database host, ImageKit (media storage), Inngest (scheduling) and our web host. They
          process data only on our behalf.
        </li>
      </ul>

      <h2>Google and YouTube data</h2>
      <p>
        When you connect YouTube, we use YouTube API Services to upload your videos, read their statistics, and read and reply to comments on your channel.
        By connecting YouTube you agree to the{" "}
        <a href="https://www.youtube.com/t/terms" className="text-primary underline underline-offset-4">
          YouTube Terms of Service
        </a>
        , and Google&apos;s handling of data is described in the{" "}
        <a href="https://policies.google.com/privacy" className="text-primary underline underline-offset-4">
          Google Privacy Policy
        </a>
        . Social Copilot&apos;s use and transfer of information received from Google APIs adheres to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" className="text-primary underline underline-offset-4">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. You can revoke access at any time at{" "}
        <a href="https://myaccount.google.com/permissions" className="text-primary underline underline-offset-4">
          myaccount.google.com/permissions
        </a>
        .
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Disconnecting an account deletes its tokens and stops all access to it. Posts you wrote stay in your Social Copilot history until you delete them.</li>
        <li>Comments are kept for your inbox and removed with the account they belong to.</li>
        <li>Deleting your Social Copilot account deletes all of the above.</li>
      </ul>

      <h2>Your choices</h2>
      <ul>
        <li>Disconnect any account on the Accounts page, or revoke access in the platform&apos;s own settings.</li>
        <li>
          Instagram: removing the app in Instagram (Settings → Website permissions → Apps and websites) revokes our access, and a deletion request sent through
          Meta deletes the connection. See <a href="/data-deletion" className="text-primary underline underline-offset-4">data deletion</a>.
        </li>
        <li>
          To delete your account or get a copy of your data, write to <Contact />.
        </li>
      </ul>
    </LegalPage>
  );
}
