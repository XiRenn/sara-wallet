import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { SignInInput, SignUpInput } from '@wallet/shared';

import { colors, fontSize, fontWeight, radii, shadow, spacing } from '../theme';

interface AuthScreenProps {
  onSubmitSignIn: (input: SignInInput) => Promise<void>;
  onSubmitSignUp: (input: SignUpInput) => Promise<{ needsEmailConfirmation: boolean }>;
  isSubmitting: boolean;
  error: string | null;
  onClearError: () => void;
}

type Mode = 'signin' | 'signup';

const MIN_PASSWORD_LENGTH = 8;

/** Login / Register form. Local validation first, then the shared service. */
export function AuthScreen({
  onSubmitSignIn,
  onSubmitSignUp,
  isSubmitting,
  error,
  onClearError,
}: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = useState(false);

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setLocalError(null);
    setConfirmationSent(false);
    onClearError();
  };

  const handleSubmit = async () => {
    setLocalError(null);
    setConfirmationSent(false);

    const trimmedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmedEmail)) {
      setLocalError('Enter a valid email address.');
      return;
    }
    if (mode === 'signup' && password.length < MIN_PASSWORD_LENGTH) {
      setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password.length === 0) {
      setLocalError('Enter your password.');
      return;
    }

    try {
      if (mode === 'signin') {
        await onSubmitSignIn({ email: trimmedEmail, password });
      } else {
        const result = await onSubmitSignUp({
          email: trimmedEmail,
          password,
          displayName: displayName.trim() || undefined,
        });
        if (result.needsEmailConfirmation) {
          setConfirmationSent(true);
          setPassword('');
        }
      }
    } catch {
      // The hook already stored a user-facing message; nothing to add here.
    }
  };

  const message = localError ?? error;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <View style={styles.logo}>
            <Text style={styles.logoGlyph}>₿</Text>
          </View>
          <Text style={styles.brandName}>Sara Wallet</Text>
          <Text style={styles.brandTagline}>
            {mode === 'signin'
              ? 'Sign in to see your balances.'
              : 'Create an account to start tracking.'}
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.segmented}>
            {(
              [
                ['signin', 'Sign in'],
                ['signup', 'Register'],
              ] as Array<[Mode, string]>
            ).map(([value, label]) => {
              const active = mode === value;
              return (
                <Pressable
                  key={value}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => switchMode(value)}
                  style={[styles.segment, active && styles.segmentActive]}
                >
                  <Text
                    style={[styles.segmentText, active && styles.segmentTextActive]}
                  >
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {mode === 'signup' ? (
            <>
              <Text style={styles.label}>Name (optional)</Text>
              <TextInput
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="e.g. Aung"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="words"
                maxLength={60}
                editable={!isSubmitting}
                style={styles.input}
              />
            </>
          ) : null}

          <Text style={styles.label}>Email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            editable={!isSubmitting}
            style={styles.input}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder={
              mode === 'signup' ? `At least ${MIN_PASSWORD_LENGTH} characters` : '••••••••'
            }
            placeholderTextColor={colors.textFaint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType={mode === 'signup' ? 'newPassword' : 'password'}
            editable={!isSubmitting}
            onSubmitEditing={handleSubmit}
            returnKeyType="go"
            style={styles.input}
          />

          {message ? <Text style={styles.error}>{message}</Text> : null}

          {confirmationSent ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                Almost there — open the confirmation link we just emailed you, then
                come back and sign in.
              </Text>
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            disabled={isSubmitting}
            onPress={handleSubmit}
            style={({ pressed }) => [
              styles.submit,
              (pressed || isSubmitting) && styles.submitPressed,
            ]}
          >
            {isSubmitting ? (
              <ActivityIndicator color={colors.textInverse} />
            ) : (
              <Text style={styles.submitText}>
                {mode === 'signin' ? 'Sign in' : 'Create account'}
              </Text>
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => switchMode(mode === 'signin' ? 'signup' : 'signin')}
            style={styles.switchLink}
          >
            <Text style={styles.switchLinkText}>
              {mode === 'signin'
                ? "Don't have an account? Register"
                : 'Already have an account? Sign in'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  brand: {
    alignItems: 'center',
    marginBottom: spacing.xxl,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: radii.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  logoGlyph: {
    fontSize: 32,
    color: colors.textInverse,
    fontWeight: fontWeight.bold,
  },
  brandName: {
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  brandTagline: {
    marginTop: spacing.xs,
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    padding: 4,
    marginBottom: spacing.lg,
  },
  segment: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
    alignItems: 'center',
  },
  segmentActive: {
    backgroundColor: colors.surface,
    ...shadow.card,
  },
  segmentText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  segmentTextActive: {
    color: colors.primary,
  },
  label: {
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.textMuted,
  },
  input: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    fontSize: fontSize.md,
    color: colors.text,
  },
  error: {
    marginTop: spacing.md,
    fontSize: fontSize.sm,
    color: colors.danger,
  },
  notice: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.primarySoft,
  },
  noticeText: {
    fontSize: fontSize.sm,
    color: colors.primaryPressed,
    lineHeight: 20,
  },
  submit: {
    marginTop: spacing.xl,
    paddingVertical: spacing.lg,
    borderRadius: radii.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  submitPressed: {
    backgroundColor: colors.primaryPressed,
  },
  submitText: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.bold,
    color: colors.textInverse,
  },
  switchLink: {
    marginTop: spacing.lg,
    alignItems: 'center',
  },
  switchLinkText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },
});
