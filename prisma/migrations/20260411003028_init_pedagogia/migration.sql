/*
  Warnings:

  - The primary key for the `User` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `email` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `passwordHash` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `whatsappId` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `Message` table. If the table is not empty, all the data it contains will be lost.
  - Changed the type of `id` on the `User` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_userId_fkey";

-- DropIndex
DROP INDEX "User_email_key";

-- DropIndex
DROP INDEX "User_whatsappId_idx";

-- DropIndex
DROP INDEX "User_whatsappId_key";

-- AlterTable
ALTER TABLE "User" DROP CONSTRAINT "User_pkey",
DROP COLUMN "email",
DROP COLUMN "passwordHash",
DROP COLUMN "updatedAt",
DROP COLUMN "whatsappId",
ADD COLUMN     "cefrLevel" TEXT NOT NULL DEFAULT 'A1',
ADD COLUMN     "lastActivity" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "streak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "targetLanguage" TEXT NOT NULL DEFAULT 'english',
ADD COLUMN     "xp" INTEGER NOT NULL DEFAULT 0,
DROP COLUMN "id",
ADD COLUMN     "id" BIGINT NOT NULL,
ADD CONSTRAINT "User_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "Message";

-- CreateTable
CREATE TABLE "Mistake" (
    "id" TEXT NOT NULL,
    "userId" BIGINT NOT NULL,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "correction" TEXT NOT NULL,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "nextReview" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mistake_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Mistake" ADD CONSTRAINT "Mistake_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
