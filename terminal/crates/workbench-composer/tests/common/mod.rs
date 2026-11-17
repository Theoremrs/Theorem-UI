#![allow(dead_code)]

use keybinds::{Key, KeyInput, Mods};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use theorem_workbench_composer::{Composer, Event, Input, Response};
use theorem_workbench_core::{
    Button, Composition, DraftAttachment, DraftAttachmentState, PanelPointer, PointerKind, Theme,
};

pub struct Rig {
    pub c: Composer,
    pub now: f64,
    pub area: Rect,
}

pub fn rig(width: u16, height: u16) -> Rig {
    let mut c = Composer::new("composer");
    let area = Rect::new(0, 0, width, height);
    c.resize(area);
    Rig {
        c,
        now: 1000.0,
        area,
    }
}

impl Rig {
    pub fn send(&mut self, input: Input) -> Response {
        self.now += 10.0;
        self.c.handle(input, self.now)
    }
    pub fn key(&mut self, key: Key, mods: Mods) -> Response {
        self.send(Input::Key(KeyInput::new(key, mods)))
    }
    pub fn press(&mut self, key: Key) -> Response {
        self.key(key, Mods::empty())
    }
    pub fn enter(&mut self) -> Response {
        self.press(Key::Enter)
    }
    pub fn type_str(&mut self, s: &str) {
        for ch in s.chars() {
            self.press(Key::Char(ch));
        }
    }
    pub fn text(&mut self, s: &str) -> Response {
        self.send(Input::Text(s.to_owned()))
    }
    pub fn paste(&mut self, s: &str) -> Response {
        self.send(Input::Paste(s.to_owned()))
    }
    pub fn compose(&mut self, c: Composition) -> Response {
        self.send(Input::Composition(c))
    }
    pub fn pointer(&mut self, kind: PointerKind, x: i32, y: i32, clicks: u8) -> Response {
        self.send(Input::Pointer(PanelPointer {
            kind,
            x,
            y,
            mods: Mods::empty(),
            clicks,
        }))
    }
    pub fn click(&mut self, x: i32, y: i32, clicks: u8) -> Response {
        self.pointer(PointerKind::Down(Button::Left), x, y, clicks)
    }
    /// The drawn area with the frame's icon pass done: no icon sentinel is left in it.
    pub fn buffer(&self) -> Buffer {
        self.drawn().0
    }
    /// The icons the composer drew, in reading order.
    pub fn icons(&self) -> Vec<theorem_workbench_core::PlacedIcon> {
        self.drawn().1
    }
    fn drawn(&self) -> (Buffer, Vec<theorem_workbench_core::PlacedIcon>) {
        let mut buf = Buffer::empty(self.area);
        self.c.draw(self.area, &mut buf, &Theme::plain());
        let icons = theorem_workbench_core::take_icons(&mut buf);
        (buf, icons)
    }
    /// Whether the row that shows `needle` is drawn in the theme's chosen-row colours.
    pub fn chosen(&self, needle: &str) -> bool {
        let focus = ratatui::style::Style::new()
            .fg(ratatui::style::Color::Reset)
            .bg(ratatui::style::Color::Reset)
            .patch(Theme::plain().focus);
        self.style_of(needle) == focus
    }
    /// The style of the first cell of `needle` on the row that shows it.
    pub fn style_of(&self, needle: &str) -> ratatui::style::Style {
        let buf = self.buffer();
        for (y, row) in dump(&buf).lines().enumerate() {
            if let Some(at) = row.find(needle) {
                return buf[(row[..at].chars().count() as u16, y as u16)].style();
            }
        }
        panic!("{needle:?} is not drawn:\n{}", self.dump());
    }
    /// The rows of the drawn area, trailing spaces trimmed.
    pub fn dump(&self) -> String {
        dump(&self.buffer())
    }
    pub fn resize(&mut self, width: u16, height: u16) {
        self.area = Rect::new(0, 0, width, height);
        self.c.resize(self.area);
    }
}

pub fn dump(buf: &Buffer) -> String {
    let a = buf.area;
    (a.y..a.y + a.height)
        .map(|y| {
            let mut row = String::new();
            let mut x = a.x;
            while x < a.x + a.width {
                let sym = buf[(x, y)].symbol();
                row.push_str(sym);
                // The cells a wide symbol covers hold blanks.
                x += unicode_width::UnicodeWidthStr::width(sym).max(1) as u16;
            }
            row.trim_end().to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn submitted(r: &Response) -> Option<&Event> {
    r.events.iter().find(|e| matches!(e, Event::Submit { .. }))
}

pub fn attachment(id: &str, name: &str, state: DraftAttachmentState) -> DraftAttachment {
    DraftAttachment {
        id: id.to_owned(),
        name: name.to_owned(),
        content_type: None,
        size: None,
        state,
        reason: (state == DraftAttachmentState::Refused).then(|| "too large".to_owned()),
    }
}

pub fn shift() -> Mods {
    Mods::SHIFT
}
pub fn ctrl() -> Mods {
    Mods::CTRL
}

/// Type `s`, returning the token of the last file query asked for.
pub fn type_asking(r: &mut Rig, s: &str) -> u64 {
    let mut token = 0;
    for ch in s.chars() {
        for e in r.press(Key::Char(ch)).events {
            if let Event::WantFiles { token: t, .. } = e {
                token = t;
            }
        }
    }
    token
}
