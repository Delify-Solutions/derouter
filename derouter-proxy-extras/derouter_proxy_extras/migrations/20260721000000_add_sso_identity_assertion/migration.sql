-- CreateTable
CREATE TABLE IF NOT EXISTS "DeRouter_SSOIdentityAssertion" (
    "user_id" TEXT NOT NULL,
    "assertion_b64" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeRouter_SSOIdentityAssertion_pkey" PRIMARY KEY ("user_id")
);
