import type { Metadata } from "next";
import { Contact, LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Terms of service" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated="October 27, 2026">
      <p>By creating an account or using Social Copilot you agree to these terms. If you do not agree, do not use the service.</p>

      <h2>The service</h2>
      <p>
        Social Copilot schedules and publishes posts to social accounts you connect, shows statistics the platforms report, and lets you read and reply to
        comments. Features depend on what each platform allows; platforms can change or limit their APIs at any time.
      </p>

      <h2>Your account and content</h2>
      <ul>
        <li>Connect only accounts you own or are authorized to manage.</li>
        <li>You are responsible for what you publish and reply, and it must follow each platform&apos;s terms and community rules.</li>
        <li>You keep all rights to your content. You give us permission to store it and send it to the platforms you choose, only to run the service.</li>
      </ul>

      <h2>Platform terms</h2>
      <p>
        Using YouTube features means you also agree to the{" "}
        <a href="https://www.youtube.com/t/terms" className="text-primary underline underline-offset-4">
          YouTube Terms of Service
        </a>
        . Instagram, LinkedIn and X have their own terms, which also apply to what you publish there.
      </p>

      <h2>Availability</h2>
      <p>
        We work to publish every post on time, but a platform outage, an expired connection or a platform rejecting a post can prevent it. Failed posts are
        shown with the reason and can be retried. The service is provided &quot;as is&quot;, without warranties, to the extent the law allows.
      </p>

      <h2>Plans</h2>
      <p>Plan limits (connected accounts, posts per month) are shown in the app. We may change plans with notice.</p>

      <h2>Ending</h2>
      <p>You can stop using the service and ask us to delete your account at any time. We may suspend accounts that break these terms or a platform&apos;s rules.</p>

      <h2>Contact</h2>
      <p>
        <Contact />
      </p>
    </LegalPage>
  );
}
