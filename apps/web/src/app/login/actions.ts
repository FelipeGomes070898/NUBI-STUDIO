'use server';
import { redirect } from 'next/navigation';
import { authConfigured, endSession, loginRateLimited, passwordMatches, recordLoginFailure, startSession } from '@/lib/auth';

export async function login(formData: FormData) {
  if (!authConfigured()) redirect('/login?error=config');
  if (await loginRateLimited()) redirect('/login?error=rate');
  if (!passwordMatches(String(formData.get('password') ?? ''))) {
    await recordLoginFailure();
    redirect('/login?error=invalid');
  }
  await startSession();
  redirect('/');
}

export async function logout() {
  await endSession();
  redirect('/login');
}
