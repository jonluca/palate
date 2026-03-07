import React from "react";
import { ProfileScreenContent } from "@/components/profile/profile-screen-content";
import { SettingsScreenContent } from "@/components/settings/settings-screen-content";
import { useSession } from "@/lib/auth-client";

export default function SettingsScreen() {
  const { data: session } = useSession();

  return session?.user ? <ProfileScreenContent showSettingsButton /> : <SettingsScreenContent showSignInButton />;
}
