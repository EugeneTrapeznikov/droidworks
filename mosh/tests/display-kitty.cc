#include "terminaldisplay.h"

#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>

namespace {
const std::string push = "\033[>7u";
const std::string pop = "\033[<u";
const std::string set = "\033[=7u";

size_t count(const std::string &text, const std::string &needle) {
  size_t total = 0;
  size_t position = 0;
  while ((position = text.find(needle, position)) != std::string::npos) {
    ++total;
    position += needle.size();
  }
  return total;
}

void require(bool condition, const char *message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}
}

int main() {
  try {
    setenv("TERM", "xterm-256color", 1);

    unsetenv("MOSH_KITTY_KEYBOARD");
    Terminal::Display plain(true);
    require(count(plain.open(), push) == 0, "default open emitted Kitty push");
    require(count(plain.close(), pop) == 0, "default close emitted Kitty pop");
    const Terminal::Framebuffer screen(80, 24);
    require(count(plain.new_frame(false, screen, screen), set) == 0, "default repaint emitted Kitty set");

    setenv("MOSH_KITTY_KEYBOARD", "invalid", 1);
    bool invalid_rejected = false;
    try {
      Terminal::Display invalid(true);
    } catch (const std::invalid_argument &) {
      invalid_rejected = true;
    }
    require(invalid_rejected, "invalid opt-in value was accepted");

    setenv("MOSH_KITTY_KEYBOARD", "1", 1);
    Terminal::Display opted_in(true);
    const std::string first_open = opted_in.open();
    require(count(first_open, push) == 1, "first open did not emit exactly one push");
    require(first_open.find("\033[?1h") < first_open.find(push), "push preceded alternate-screen setup");
    require(count(opted_in.open(), push) == 0, "duplicate open emitted a second push");
    require(count(opted_in.new_frame(false, screen, screen), set) == 1, "full repaint did not re-assert Kitty flags once");
    require(opted_in.new_frame(true, screen, screen).empty(), "unchanged frame emitted output");
    Terminal::Framebuffer drawn(80, 24);
    drawn.get_mutable_cell(0, 0)->append(L'x');
    require(count(opted_in.new_frame(true, screen, drawn), set) == 1, "drawing frame did not re-assert Kitty flags once");
    const Terminal::Framebuffer resized(100, 30);
    require(count(opted_in.new_frame(true, screen, resized), set) == 1, "resize repaint did not re-assert Kitty flags");

    const std::string first_close = opted_in.close();
    require(count(first_close, pop) == 1, "first close did not emit exactly one pop");
    require(first_close.find(pop) < first_close.size() - pop.size(), "pop was not emitted before screen restore");
    require(count(opted_in.close(), pop) == 0, "duplicate close emitted a second pop");
    require(count(opted_in.new_frame(false, screen, screen), set) == 0, "closed display re-asserted Kitty flags");
    require(count(opted_in.new_frame(true, screen, drawn), set) == 0, "closed display re-asserted Kitty flags while drawing");
    require(count(opted_in.open(), push) == 1, "reopen did not emit one push");
    require(count(opted_in.close(), pop) == 1, "reclose did not emit one pop");

    std::cout << "display-kitty: PASS\n";
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "display-kitty: FAIL: " << error.what() << "\n";
    return 1;
  }
}
