import { Button, StyleSheet, Text, View } from "react-native";

export function ErrorFallback({ resetError }: { resetError: () => void }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Unable to load this screen</Text>
      <Text style={styles.message}>Please try again in a moment.</Text>
      <Button title={"Try again"} onPress={resetError} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#FFFFFF" },
  title: { color: "#111111", fontSize: 22, fontWeight: "600", marginBottom: 12 },
  message: { color: "#444444", fontSize: 16, marginBottom: 24 },
});
