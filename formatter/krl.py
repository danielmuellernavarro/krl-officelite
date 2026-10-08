import re
import sys
import defaultKwargs

# Motion / option keywords in KRL motion instructions for which the
# "Key=Value" form must be kept compact (e.g. PTP P1 Vel=100% C_PTP=10).
# Formatting them with spaces around '=' would produce invalid instructions
# (e.g. "Vel = 100%").
MOTION_OPT_KEYS = [
    'VEL', 'C_DIS', 'C_PTP', 'PDAT', 'FDAT', 'TOOL', 'BASE', 'CONT', 'CP',
    'APO', 'PRIO', 'TRIGGER', 'WHEN', 'DISTANCE', 'EVERY', 'GEAR', 'GUN',
    'TQ', 'MAXAGC', 'FITNESS', 'POSP', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6',
    'S7', 'S8', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8',
]


class Formatter:
    # control sequences
    ctrl_1line = re.compile(r'(^|\s*)(if|while|for|loop)(\W\s*\S.*\W)((endif|endwhile|endfor|endloop);?)(\s+\S.*|\s*$)', re.IGNORECASE)
    fcnstart = re.compile(r'(^|\s*)(global\s+)?(deffct|defdat|def)\b\s*(.*)$', re.IGNORECASE)
    fcnend = re.compile(r'(^|\s*)(global\s+)?(endfct|enddat|end)\b\s*(.*)$', re.IGNORECASE)

    # &ACCESS / &REL / &PARAM header lines and any other &... attribute line
    header = re.compile(r'^\s*&.*$')
    ctrlstart_for = re.compile(r'(^|\s*)(for)\s+(.*?)\s+(to)\s+(.*)$', re.IGNORECASE)
    ctrlstart_then = re.compile(r'(^|\s*)(if)\s*(.*?)\s+(then)\b\s*(.*)$', re.IGNORECASE)
    ctrlstart = re.compile(r'(^|\s*)(while|loop|repeat)\s*(.*)$', re.IGNORECASE)
    ctrlstart_2 = re.compile(r'(^|\s*)(switch)\s*(.*)$', re.IGNORECASE)
    ctrlcont = re.compile(r'(^|\s*)(else|case|default)\s*(.*)$', re.IGNORECASE)
    ctrlend = re.compile(r'(^|\s*)(endif|endwhile|endfor|endloop|endswitch|until)\s*(.*)$', re.IGNORECASE)
    # lines which are pure comments (also handles ;FOLD / ;ENDFOLD)
    linecomment = re.compile(r'^\s*;.*$', re.IGNORECASE)
    findstring = re.compile(r'(.*)"(.*)"(.*)')

    # patterns
    p_comment = re.compile(r'(^|.*\S)\s*(;)(.*)')
    p_blank = re.compile(r'^\s+$')
    p_num_R = re.compile(r'(^|.*\W)\s*(\d+)\s*(\/)\s*(\d+)(.*)')
    p_sign = re.compile(r'(^|.*[\(\[\{,;:=\*/])\s*(\+|-)(\w.*)')
    p_arg_colon = re.compile(r'(^|.*\S)\s*(:)\s*(\S.*|$)')
    p_op = re.compile(r'(^|.*\S)\s*(<>|==|<=|>=)\s*(\S.*|$)')
    p_2op = re.compile(r'(^|.*\S)\s*(\*|\\|\||(?<!^)&)\s*(\S.*|$)')
    p_3op = re.compile(r'(^|.*\S)\s*(\+|-|=|!|~|<|>|(?<!^)&)\s*(\S.*|$)')
    p_4op = re.compile(r'(^|.*\S)\s(B_|AND|OR|EXOR)\s(\S.*|$)', re.IGNORECASE)
    p_comma = re.compile(r'(^|.*\S)\s*(,)\s*(\S.*|$)')
    p_multiws = re.compile(r'(^|.*\S)(\s{2,})(\S.*|$)')
    p_string = re.compile(r'(^|.*[\\(\\[\\{,;=\\+\\-\\s])\\s*(\\"[^\\"]*\\")([\\)\\}\\]\\+\\-,;].*|\\s+.*|$)')
    # compact "Key=Value" inside motion instructions (e.g. Vel=100%)
    p_opt_equal = re.compile(r'\b((' + '|'.join(sorted(MOTION_OPT_KEYS, key=len, reverse=True)) + r'))=(\S+)', re.IGNORECASE)
    # whitespace before a closing bracket (e.g. "(x, 1 )" -> "(x, 1)")
    p_nospace_close = re.compile(r'(^|.*\S)\s+([)}\]\]])(.*)$')

    # indentation
    ilvl = 0
    step = []

    def __init__(self, **kwargs):
        self.filename = kwargs['filename']
        self.startLine = kwargs['startLine']
        self.endLine = kwargs['endLine']

        self.indentWidth = kwargs.get('indentWidth', defaultKwargs.kwargs['indentWidth'])
        self.separateBeforeBlocks = kwargs.get('separateBeforeBlocks', defaultKwargs.kwargs['separateBeforeBlocks'])
        self.separateAfterBlocks = kwargs.get('separateAfterBlocks', defaultKwargs.kwargs['separateAfterBlocks'])
        self.indentAfterFunction = kwargs.get('indentAfterFunction', defaultKwargs.kwargs['indentAfterFunction'])
        self.indentAfterMainFunction = kwargs.get('indentAfterMainFunction', defaultKwargs.kwargs['indentAfterMainFunction'])

        self.isDatFile = False
        # first DEF is treated as the main / submit entry (written unindented)
        self.firstDef = True
        # parallel bookkeeping of whether each DEF/DEFFCT pushed indentation;
        # lets END / ENDFCT / ENDDAT always pop what its own opener pushed
        self.fcnSteps = []

    # divide string into three parts by extracting and formatting certain expressions
    def extract_comment(self, part):
        m = self.p_comment.match(part)
        if m:
            return (m.group(1) + ' ', m.group(2) + ' ', m.group(3).lstrip())

        return 0

    def extract(self, part):
        # whitespace only
        m = self.p_blank.match(part)
        if m:
            return ('', ' ', '')

        m = self.p_string.match(part)
        if m:
            return (m.group(1), m.group(2), m.group(4))

        comment = self.extract_comment(part)
        if comment:
            return comment

        # rational number (e.g. 1/4)
        m = self.p_num_R.match(part)
        if m:
            return (m.group(1) + m.group(2), m.group(3), m.group(4) + m.group(5))

        # compact "Key=Value" inside motion instructions (e.g. Vel=100%)
        m = self.p_opt_equal.search(part)
        if m and not self.isDatFile:
            return (part[:m.start()], m.group(0), part[m.end():])

        # signum (unary - or +)
        m = self.p_sign.match(part)
        if m:
            return (m.group(1), m.group(2), m.group(3))

        # type / parameter colon (e.g. x:IN) - kept compact
        m = self.p_arg_colon.match(part)
        if m:
            return (m.group(1), m.group(2), m.group(3).lstrip())

        # ==, >=, <=, <>, etc
        m = self.p_op.match(part)
        if m and not self.isDatFile:
            return (m.group(1) + ' ', m.group(2), ' ' + m.group(3))

        # single operator (e.g. /, *, etc.)
        m = self.p_2op.match(part)
        if m and not self.isDatFile:
            return (m.group(1) + ' ', m.group(2), ' ' + m.group(3))

        # single operator (e.g. +, -, etc.)
        m = self.p_3op.match(part)
        if m and not self.isDatFile:
            return (m.group(1) + ' ', m.group(2), ' ' + m.group(3))

        # single operator (AND OR XOR B_)
        m = self.p_4op.match(part)
        if m and not self.isDatFile:
            return (m.group(1) + ' ', m.group(2), ' ' + m.group(3))

        # comma/semicolon
        m = self.p_comma.match(part)
        if m and not self.isDatFile:
            return (m.group(1), m.group(2), ' ' + m.group(3))

        # multiple whitespace
        m = self.p_multiws.match(part)
        if m:
            return (m.group(1), ' ', m.group(3))

        # whitespace before a closing bracket  ( 0 ) -> ( 0)
        m = self.p_nospace_close.match(part)
        if m:
            return (m.group(1), m.group(2), m.group(3))

        return 0

    # recursively format string
    def format(self, part):
        m = self.extract(part)
        if m:
            return self.format(m[0]) + m[1] + self.format(m[2])
        return part


    # compute indentation
    def indent(self, add=0):
        return (self.ilvl + add) * self.indentWidth * ' '

    def _fcn_prefix(self, m):
        """Reassemble the beginning of a DEF/DEFFCT/DEFDAT/END/... line."""
        _global = (m.group(2) or '').strip()
        return ((_global + ' ') if _global else '') + m.group(3)

    # take care of indentation and call format(line)
    def formatLine(self, line):

        # determine if header (&ACCESS, &REL, ...) - keep verbatim
        if re.match(self.header, line):
            return (0, line.rstrip())

        # ;FOLD / ;ENDFOLD marker lines: keep the marker and its content
        # verbatim, only re-indent to the current block level
        fold = re.match(r'^(\s*)(;FOLD|;ENDFOLD)(.*)$', line, re.IGNORECASE)
        if fold:
            return (0, self.indent() + fold.group(2) + fold.group(3).rstrip())

        # plain comment lines - re-indent to the current block level
        if re.match(self.linecomment, line):
            return (0, self.indent() + line.strip())

        # find control structures
        m = re.match(self.ctrl_1line, line)
        if m:
            return (0, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip() + ' ' + m.group(4) + ' ' + self.format(m.group(6)).strip())

        m = re.match(self.fcnstart, line)
        if m:
            _kw = m.group(3).lower()
            _prefix = self._fcn_prefix(m)
            _rest = self.format(m.group(4)).strip()

            # DEFDAT ... / ENDDAT never add indentation
            if _kw == 'defdat':
                self.fcnSteps.append(0)
                return (0, self.indent() + _prefix + ' ' + _rest)

            # the first DEF of a program (main() or SUBMITn()) is unindented
            if _kw == 'def' and self.firstDef:
                self.firstDef = False
                if not self.indentAfterMainFunction:
                    self.fcnSteps.append(0)
                    return (0, self.indent() + _prefix + ' ' + _rest)

            if self.indentAfterFunction:
                self.step.append(1)
                self.fcnSteps.append(1)
                return (1, self.indent() + _prefix + ' ' + _rest)

            self.fcnSteps.append(0)
            return (0, self.indent() + _prefix + ' ' + _rest)

        m = re.match(self.fcnend, line)
        if m:
            _kw = m.group(3).lower()
            _prefix = self._fcn_prefix(m)
            _rest = self.format(m.group(4)).strip()

            if len(self.fcnSteps) > 0:
                _fstep = self.fcnSteps.pop()
            else:
                print('There are more end-statements than begin-statements!', file=sys.stderr)
                _fstep = 0

            if _kw == 'enddat':
                return (0, self.indent() + _prefix + ' ' + _rest)

            if _fstep and self.indentAfterFunction:
                if len(self.step) > 0:
                    _step = self.step.pop()
                else:
                    print('There are more end-statements than blocks!', file=sys.stderr)
                    _step = 0
                return (-_step, self.indent(-_step) + _prefix + ' ' + _rest)

            return (0, self.indent() + _prefix + ' ' + _rest)

        m = re.match(self.ctrlstart_for, line)
        if m:
            self.step.append(1)
            return (1, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip() + ' ' + m.group(4) + ' ' + self.format(m.group(5)).strip())

        m = re.match(self.ctrlstart_then, line)
        if m:
            self.step.append(1)
            return (1, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip() + ' ' + m.group(4) + ' ' + self.format(m.group(5)).strip())

        m = re.match(self.ctrlstart, line)
        if m:
            self.step.append(1)
            return (1, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip())

        m = re.match(self.ctrlstart_2, line)
        if m:
            self.step.append(2)
            return (2, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip())

        m = re.match(self.ctrlcont, line)
        if m:
            return (0, self.indent(-1) + m.group(2) + ' ' + self.format(m.group(3)).strip())

        m = re.match(self.ctrlend, line)
        if m:
            if len(self.step) > 0:
                _step = self.step.pop()
            else:
                print('There are more end-statements than blocks!', file=sys.stderr)
                _step = 0
            return (-_step, self.indent(-_step) + m.group(2) + ' ' + self.format(m.group(3)).strip())

        m = re.match(self.findstring, line)
        if m:
            return (0, self.indent() + self.format(line).lstrip())

        return (0, self.indent() + self.format(line).strip())

    # format file from line self.startLine to line self.endLine
    def formatFile(self):
        rlines = list()
        wlines = list()
        self.isDatFile = self.filename.endswith('.dat')

        # read lines from file
        if self.filename == '-':
            with sys.stdin as f:
                rlines = f.readlines()[self.startLine - 1:self.endLine]
        else:
            with open(self.filename, 'r', encoding='UTF-8') as f:
                rlines = f.readlines()[self.startLine - 1:self.endLine]

        # take care of empty input
        if not rlines:
            rlines = ['']

        # get initial indent lvl from the first non-blank line; a blank
        # leading line must not push the whole document to the right
        if rlines and re.match(r'^\s*$', rlines[0]):
            self.ilvl = 0
        else:
            p = r'(\s*)(.*)'
            m = re.match(p, rlines[0])
            if m:
                self.ilvl = len(m.group(1)) // self.indentWidth
                rlines[0] = m.group(2)

        blank = True
        lastLineIsComment = False
        for line in rlines:
            # remove additional newlines
            if re.match(r'^\s*$', line):
                if not blank:
                    blank = True
                    wlines.append('')
                continue

            # format line
            (offset, line) = self.formatLine(line)

            m = re.match(self.fcnend, line)
            if m and not blank:
                wlines.append('')

            # adjust indent lvl
            self.ilvl = max(0, self.ilvl + offset)

            m = re.match(self.fcnstart, line)
            isFcnstart = bool(m)

            m = re.match(self.fcnend, line)
            isFcnend = bool(m)

            # add newline before block
            if self.separateBeforeBlocks and (offset > 0 or isFcnstart) and not blank and not lastLineIsComment:
                wlines.append('')

            # add formatted line
            wlines.append(line.rstrip())

            # add newline after block
            if self.separateAfterBlocks and (offset < 0 or isFcnend):
                wlines.append('')
                blank = True
            else:
                blank = False

            m = re.match(self.p_comment, line)
            lastLineIsComment = bool(m)

        # remove last line if blank
        while wlines and not wlines[-1]:
            wlines.pop()

        # take care of empty output
        if not wlines:
            wlines = ['']

        # write output
        for line in wlines:
            print(line)
