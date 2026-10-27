/**
 * Transactional email delivery.
 *
 * All outbound product email (email verification, one-time passcodes, password
 * resets) goes through the Brevo provider in `./brevo`. Import from here rather
 * than from the provider module so a future provider swap is a one-file change.
 */
export {
  BREVO_API_URL,
  EmailDeliveryError,
  isEmailDeliveryConfigured,
  parseEmailSender,
  resolveEmailConfig,
  sendTransactionalEmail,
  type EmailConfig,
  type EmailSender,
  type OutgoingEmail,
} from './brevo';

export {
  formatCode,
  renderPasswordResetEmail,
  renderVerificationEmail,
  type AuthEmailInput,
  type RenderedEmail,
} from './templates';
