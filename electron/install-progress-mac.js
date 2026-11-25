ObjC.import('AppKit');
ObjC.import('QuartzCore');

function run() {
  const env = $.NSProcessInfo.processInfo.environment;
  const value = key => ObjC.unwrap(env.objectForKey(key));
  const marker = value('ASTER_INSTALL_MARKER'), token = value('ASTER_INSTALL_TOKEN');
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  app.finishLaunching;
  const panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, 372, 152), $.NSWindowStyleMaskBorderless, $.NSBackingStoreBuffered, false);
  panel.title = 'AsterPDF';
  panel.opaque = false;
  panel.backgroundColor = $.NSColor.clearColor;
  panel.hasShadow = true;
  panel.releasedWhenClosed = false;
  panel.hidesOnDeactivate = false;
  panel.level = $.NSFloatingWindowLevel;

  const color = (r, g, b) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(r / 255, g / 255, b / 255, 1);
  function rounded(view, radius, fill) {
    view.wantsLayer = true;
    view.layer.cornerRadius = radius;
    view.layer.backgroundColor = fill.CGColor;
  }
  const card = panel.contentView;
  rounded(card, 18, color(251, 252, 249));
  const logo = $.NSImageView.alloc.initWithFrame($.NSMakeRect(26, 90, 42, 42));
  logo.image = $.NSImage.alloc.initWithContentsOfFile(value('ASTER_INSTALL_LOGO'));
  logo.imageScaling = $.NSImageScaleProportionallyUpOrDown;
  card.addSubview(logo);

  function label(text, x, y, font, ink) {
    const field = $.NSTextField.labelWithString(text);
    field.font = font;
    field.textColor = ink;
    field.sizeToFit;
    field.setFrameOrigin($.NSMakePoint(x, y));
    card.addSubview(field);
    return field;
  }
  const bold = $.NSFont.boldSystemFontOfSize(24);
  const brand = label('Aster', 77, 96, bold, color(25, 45, 40));
  label('PDF', 75 + brand.frame.size.width, 96, bold, color(115, 148, 38));
  const status = label(value('ASTER_INSTALL_TEXT'), 26, 46, $.NSFont.systemFontOfSize(14), color(71, 91, 80));
  status.frame = $.NSMakeRect(26, 46, 320, 22);
  if (value('ASTER_INSTALL_RTL') === '1') status.alignment = $.NSTextAlignmentRight;
  const track = $.NSView.alloc.initWithFrame($.NSMakeRect(26, 20, 320, 6));
  rounded(track, 3, color(227, 235, 217));
  card.addSubview(track);
  const pulse = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, 92, 6));
  rounded(pulse, 3, color(166, 204, 66));
  track.addSubview(pulse);
  if (!$.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
    const motion = $.CABasicAnimation.animationWithKeyPath('transform.translation.x');
    motion.fromValue = $(0);
    motion.toValue = $(228);
    motion.duration = 1.6;
    motion.autoreverses = true;
    motion.repeatCount = 1e9;
    motion.timingFunction = $.CAMediaTimingFunction.functionWithName('easeInEaseOut');
    pulse.layer.addAnimationForKey(motion, 'travel');
  }
  panel.center;
  panel.orderFrontRegardless;
  $(token).writeToFileAtomicallyEncodingError(value('ASTER_INSTALL_READY'), true, $.NSUTF8StringEncoding, null);
  const deadline = Date.now() + 300000;
  let overdue = false;
  while (panel.isVisible) {
    if (!overdue && Date.now() > deadline) {
      overdue = true;
      status.stringValue = value('ASTER_INSTALL_WAIT');
      panel.level = $.NSNormalWindowLevel;
    }
    const data = $.NSFileManager.defaultManager.contentsAtPath(marker);
    if (!data || ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) !== token) break;
    const event = app.nextEventMatchingMaskUntilDateInModeDequeue($.NSEventMaskAny,
      $.NSDate.dateWithTimeIntervalSinceNow(0.3), $.NSDefaultRunLoopMode, true);
    if (event && !event.isNil()) app.sendEvent(event);
    app.updateWindows;
  }
}
