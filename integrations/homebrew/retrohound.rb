# Formula template for an own tap (docs/integrations.md, Homebrew). Copy to Formula/retrohound.rb in a
# homebrew-<name> repository. On a version bump, update url and sha256 together.
class Retrohound < Formula
  desc "Audit what your AI coding agent did: Sigma rules over agent transcripts, offline"
  homepage "https://github.com/Raman-Lab1/RetroHound"
  url "https://registry.npmjs.org/retrohound/-/retrohound-0.3.1.tgz"
  # PLACEHOLDER until 0.3.1 is on npm: the SHA-256 of the published tarball, `curl -sL <url> | shasum -a 256`.
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/retrohound --version")
    # functional: the bundled rules load and preflight runs offline on an empty directory
    assert_match "0 rejected", shell_output("#{bin}/retrohound rules list")
    assert_match "no findings", shell_output("#{bin}/retrohound preflight #{testpath}")
  end
end
