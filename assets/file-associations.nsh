; Register PDF support without replacing the user's default PDF application.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\AsterPDF.PDF" "" "PDF document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\AsterPDF.PDF\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\AsterPDF.PDF\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "AsterPDF.PDF"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "AsterPDF"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\AsterPDF\Capabilities" "ApplicationName" "AsterPDF"
  WriteRegStr SHELL_CONTEXT "Software\AsterPDF\Capabilities" "ApplicationDescription" "Read and edit PDF documents"
  WriteRegStr SHELL_CONTEXT "Software\AsterPDF\Capabilities\FileAssociations" ".pdf" "AsterPDF.PDF"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "AsterPDF" "Software\AsterPDF\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "AsterPDF.PDF"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\AsterPDF.PDF"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey SHELL_CONTEXT "Software\AsterPDF\Capabilities"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\AsterPDF"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "AsterPDF"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
