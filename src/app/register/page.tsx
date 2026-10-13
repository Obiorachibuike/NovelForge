import RegisterClient from './RegisterClient';
import { googleSignInEnabled } from '@/lib/auth/providers';

export const metadata = { title: 'Create your NovelForge studio' };

/** Rendered per request so the Google option reflects the live configuration. */
export const dynamic = 'force-dynamic';

export default function RegisterPage() {
  // Server-resolved so the Google option only appears when it can work.
  return <RegisterClient googleEnabled={googleSignInEnabled()} />;
}
