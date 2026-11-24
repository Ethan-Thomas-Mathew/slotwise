// Environment for tests. Points at the separate slotwise_test database.
const host = process.env.TEST_DB_HOST ?? 'localhost';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= `postgresql://slotwise_app:app_password@${host}:5432/slotwise_test`;
process.env.MIGRATION_DATABASE_URL ??= `postgresql://slotwise_owner:owner_password@${host}:5432/slotwise_test`;
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.RAZORPAY_WEBHOOK_SECRET ??= 'test_webhook_secret';
process.env.PAYMENTS_PROVIDER ??= 'mock';
process.env.LOG_LEVEL ??= 'silent';
