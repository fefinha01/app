; Instalador/desinstalador do RavokBot - visual proprio (tema escuro azul da marca).
; Tema claro da marca: corpo branco #FFFFFF, texto #16233D, destaque #1570EF (cabecalho e lateral em azul-escuro).

!define MUI_BGCOLOR "FFFFFF"
!define MUI_TEXTCOLOR "16233D"

!ifndef BUILD_UNINSTALLER
  !define MUI_FINISHPAGE_TITLE "RavokBot instalado!"
  !define MUI_FINISHPAGE_TEXT "A instalação foi concluída com sucesso.$\r$\n$\r$\nUm atalho foi criado na sua área de trabalho. Clique em Concluir para fechar o assistente."
!else
  !define MUI_FINISHPAGE_TITLE "RavokBot removido"
  !define MUI_FINISHPAGE_TEXT "O RavokBot foi desinstalado do seu computador.$\r$\n$\r$\nObrigado por usar o RavokBot!"
!endif

; Barra de progresso azul da marca (desliga o tema do Windows so nessa barra).
!macro ravokStyleProgress
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $0 $0 1004
  System::Call 'uxtheme::SetWindowTheme(p $0, w " ", w " ")'
  SendMessage $0 0x0409 0 0xEF7015
  SendMessage $0 0x2001 0 0xEFE8E3
!macroend

; ---------------------------------------------------------------------------
; Tema claro da marca em TODAS as paginas.
;  ravokThemeFrame : barra de titulo, fundo da janela, rodape e botoes (persistem entre paginas)
;  ravokTheme      : frame + corpo da pagina atual (textos, campos, listas, botoes)
; Cores: corpo #FFFFFF | rodape #F3F6FB | texto #16233D | secundario #6B7890
; Tudo e "melhor esforco": em Windows antigo que nao suporta algum recurso, so fica no visual padrao.
; ---------------------------------------------------------------------------
!macro ravokDefineThemeFuncs UN
  Function ${UN}ravokThemeFrame
    Push $R0
    Push $R1
    ; Barra de titulo clara (Windows 11)
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 0, i 4) i .R1'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0xFBF6F3, i 4) i .R1'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i 0x3D2316, i 4) i .R1'
    ; Fundo da janela principal e texto do rodape
    SetCtlColors $HWNDPARENT "" "F3F6FB"
    GetDlgItem $R0 $HWNDPARENT 1028
    SetCtlColors $R0 /BRANDING "6B7890" "F3F6FB"
    ; Botoes Voltar / Proximo / Cancelar no estilo escuro
    GetDlgItem $R0 $HWNDPARENT 1
    System::Call 'uxtheme::SetWindowTheme(p $R0, w "Explorer", p 0)'
    GetDlgItem $R0 $HWNDPARENT 2
    System::Call 'uxtheme::SetWindowTheme(p $R0, w "Explorer", p 0)'
    GetDlgItem $R0 $HWNDPARENT 3
    System::Call 'uxtheme::SetWindowTheme(p $R0, w "Explorer", p 0)'
    System::Call 'user32::InvalidateRect(p $HWNDPARENT, p 0, i 1)'
    Pop $R1
    Pop $R0
  FunctionEnd

  Function ${UN}ravokTheme
    Call ${UN}ravokThemeFrame
    Push $R0
    Push $R1
    Push $R2
    ; Corpo da pagina atual
    FindWindow $R0 "#32770" "" $HWNDPARENT
    StrCmp $R0 0 ravokThemeDone
    SetCtlColors $R0 "" "FFFFFF"
    StrCpy $R1 0
    ravokThemeLoop:
      FindWindow $R1 "" "" $R0 $R1
      StrCmp $R1 0 ravokThemeEnd
      System::Call 'user32::GetClassName(p $R1, t .R2, i 64)'
      StrCmp $R2 "Static" ravokIsStatic
      StrCmp $R2 "Button" ravokIsButton
      StrCmp $R2 "Edit" ravokIsEdit
      StrCmp $R2 "SysListView32" ravokIsList
      StrCmp $R2 "SysTreeView32" ravokIsTree
      Goto ravokThemeLoop
    ravokIsStatic:
      SetCtlColors $R1 "16233D" "transparent"
      Goto ravokThemeLoop
    ravokIsButton:
      System::Call 'uxtheme::SetWindowTheme(p $R1, w "Explorer", p 0)'
      Goto ravokThemeLoop
    ravokIsEdit:
      SetCtlColors $R1 "16233D" "FFFFFF"
      System::Call 'uxtheme::SetWindowTheme(p $R1, w "CFD", p 0)'
      Goto ravokThemeLoop
    ravokIsList:
      SendMessage $R1 0x1001 0 0xFFFFFF
      SendMessage $R1 0x1024 0 0x3D2316
      SendMessage $R1 0x1026 0 0xFFFFFF
      System::Call 'uxtheme::SetWindowTheme(p $R1, w "Explorer", p 0)'
      Goto ravokThemeLoop
    ravokIsTree:
      SendMessage $R1 0x111D 0 0xFFFFFF
      SendMessage $R1 0x111E 0 0x3D2316
      System::Call 'uxtheme::SetWindowTheme(p $R1, w "Explorer", p 0)'
      Goto ravokThemeLoop
    ravokThemeEnd:
      System::Call 'user32::InvalidateRect(p $R0, p 0, i 1)'
    ravokThemeDone:
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd
!macroend

!ifndef BUILD_UNINSTALLER
  !insertmacro ravokDefineThemeFuncs ""

  Function ravokInstFilesShow
    Call ravokTheme
    !insertmacro ravokStyleProgress
  FunctionEnd
!else
  !insertmacro ravokDefineThemeFuncs "un."
!endif

!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Bem-vindo ao RavokBot"
  !define MUI_WELCOMEPAGE_TEXT "Este assistente vai instalar o RavokBot no seu computador.$\r$\n$\r$\nFeche o RavokBot caso ele esteja aberto e clique em Avançar para continuar."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ravokThemeFrame
  !insertmacro MUI_PAGE_WELCOME
  ; a proxima pagina (escolha da pasta) recebe o tema claro completo
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ravokTheme
!macroend

!macro customPageAfterChangeDir
  !ifdef MUI_PAGE_CUSTOMFUNCTION_SHOW
    !undef MUI_PAGE_CUSTOMFUNCTION_SHOW
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ravokInstFilesShow
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Desinstalar o RavokBot"
  !define MUI_WELCOMEPAGE_TEXT "Este assistente vai remover o RavokBot do seu computador.$\r$\n$\r$\nFeche o RavokBot caso ele esteja aberto e clique em Avançar para continuar."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ravokThemeFrame
  !insertmacro MUI_UNPAGE_WELCOME
  ; a proxima pagina (componentes / apagar dados) recebe o tema claro completo
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ravokTheme
!macroend

!macro customUnInstall
  Call un.ravokTheme
  !insertmacro ravokStyleProgress
!macroend

!macro ravokWipeData
  SetShellVarContext current
  RMDir /r "$APPDATA\RavokBot"
  RMDir /r "$APPDATA\ravokbot"
  RMDir /r "$LOCALAPPDATA\RavokBot"
  RMDir /r "$LOCALAPPDATA\ravokbot"
  RMDir /r "$LOCALAPPDATA\ravokbot-updater"
  RMDir /r "$TEMP\RavokBot"
  Delete "$DESKTOP\RavokBot.lnk"
  RMDir /r "$SMPROGRAMS\RavokBot"
  DeleteRegKey HKCU "Software\RavokBot"
!macroend

; Instalação: se encontrar restos de uma instalação antiga, oferece limpar tudo.
!macro customInit
  SetShellVarContext current
  ${If} ${FileExists} "$APPDATA\RavokBot\*.*"
    MessageBox MB_YESNO|MB_ICONQUESTION "Encontramos dados de uma instalação anterior do RavokBot (configurações, sessão, contas, proxies e perfis das telas).$\r$\n$\r$\nDeseja APAGAR todos os rastros antigos e instalar do zero?$\r$\n$\r$\nSim = instalação limpa   |   Não = manter dados" /SD IDNO IDNO ravokKeep
    !insertmacro ravokWipeData
    ravokKeep:
  ${EndIf}
!macroend

; Desinstalação: caixinha na tela de componentes. Marcada = apaga absolutamente tudo.
!macro customUnInstallSection
  Section /o "un.Apagar todos os dados e rastros do RavokBot (contas, proxies, sessão, configurações e perfis)" ravokWipeSection
    !insertmacro ravokWipeData
  SectionEnd
!macroend
