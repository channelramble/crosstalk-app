import { expect, test } from "bun:test";
import { installHint } from "../src/providers";

test("an install hint names the package manager the machine has", () => {
  const only = (...bins: string[]) => (bin: string) => bins.includes(bin);
  expect(installHint("gh", "gh", "darwin", only())).toBe("brew install gh");
  expect(installHint("gh", "gh", "linux", only("apt-get"))).toBe("sudo apt install -y gh");
  expect(installHint("gh", "gh", "linux", only("dnf"))).toBe("sudo dnf install -y gh");
  expect(installHint("gh", "gh", "linux", only("pacman"))).toBe("sudo pacman -S --noconfirm gh");
  expect(installHint("gh", "gh", "linux", only("zypper"))).toBe("sudo zypper install -y gh");
  expect(installHint("gh", "gh", "linux", only("apk"))).toBe("sudo apk add gh");
  // Debian's own comes first where a machine has two, and apt is the guess where none is found.
  expect(installHint("gh", "gh", "linux", only("dnf", "apt-get"))).toBe("sudo apt install -y gh");
  expect(installHint("gh", "gh", "linux", only())).toBe("sudo apt install -y gh");
});
