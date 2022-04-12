import re
import sys
import defaultKwargs


class Formatter:
    # control sequences
    ctrl_1line = re.compile(r'(^|\s*)(if|while|for|loop)(\W\s*\S.*\W)((endif|endwhile|endfor|endloop);?)(\s+\S.*|\s*$)', re.IGNORECASE)
    fcnstart = re.compile(r'(^|\s*)(def|deffct|global\Wdef|global\Wdeffct)\s*(\W\s*\S.*|\s*$)', re.IGNORECASE)
    fcnend = re.compile(r'(^|\s*)(end|endfct)\s*(\W\s*\S.*|\s*$)', re.IGNORECASE)

    header = re.compile(r'(&ACCESS|&REL|&PARAM)')
    ctrlstart_for = re.compile(r'(^|\s*)(for)\s*(\W\s*\S.*|\s)(to)(\W\s*\S.*|\s*$)', re.IGNORECASE)
    ctrlstart_then = re.compile(r'(^|\s*)(if)\s*(\W\s*\S.*|\s)(then)(\W\s*\S.*|\s*$)', re.IGNORECASE)
    ctrlstart = re.compile(r'(^|\s*)(if|while|loop|repeat)\s*(\W\s*\S.*|\s*$)', re.IGNORECASE)
    ctrlstart_2 = re.compile(r'(^|\s*)(switch)\s*(\W\s*\S.*|\s*$)', re.IGNORECASE)
    ctrlcont = re.compile(r'(^|\s*)(else|case|default)\s*(\W\s*\S.*|\s*$)', re.IGNORECASE)
    ctrlend = re.compile(r'(^|\s*)((endif|endwhile|endfor|endloop|endswitch|until);?)(\s+\S.*|\s*$)', re.IGNORECASE)
    linecomment = re.compile(r'(^|\s*)(;FOLD|;ENDFOLD|;).*$', re.IGNORECASE)
    findstring = re.compile(r'(.*)"(.*)"(.*)')

    # patterns
    p_comment = re.compile(r'(^|.*\S)\s*((;|&).*)')
    p_blank = re.compile(r'^\s+$')
    p_num_R = re.compile(r'(^|.*\W)\s*(\d+)\s*(\/)\s*(\d+)(.*)')
    p_sign = re.compile(r'(.*[\(\[\{,;:=\*/\s])\s*(\+|\-)(\w.*)')
    p_arg_colon = re.compile(r'(^|.*\S)\s*(:)\s*(\S.*|$)')
    p_op = re.compile(r'(^|.*\S)\s*(<>|==|<=|>=)\s*(\S.*|$)')
    p_2op = re.compile(r'(^|.*\S)\s*(\*|\\|/|\||(?<!^)\&)\s*(\S.*|$)')
    p_3op = re.compile(r'(^|.*\S)\s*(\+|\-|=|!|~|<|>|(?<!^)\&)\s*(\S.*|$)')
    p_4op = re.compile(r'(^|.*\S)\s(B_|AND|OR|EXOR)\s(\S.*|$)', re.IGNORECASE)
    p_func = re.compile(r'(.*\w)(\()\s*(\S.*|$)')
    p_func_2 = re.compile(r'(.*\w)(\))\s*(\S.*)')
    p_func_3 = re.compile(r'(.*\w)( )(\))\s*(\S.*|$)')
    p_func_4 = re.compile(r'(^|.*)(\()( )\s*(\S.*|$)')
    p_comma = re.compile(r'(^|.*\S)\s*(,)\s*(\S.*|$)')
    p_multiws = re.compile(r'(^|.*\S)(\s{2,})(\S.*|$)')
    p_string = re.compile(r'(^|.*[\(\[\{,;=\+\-\s])\s*(\"([^\"])*\")([\)\}\]\+\-,;].*|\s+.*|$)')

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
        self.firstDef = True
        self.firstEnddef = True
    # divide string into three parts by extracting and formatting certain expressions
    def extract_comment(self, part):
        m = self.p_comment.match(part)
        if m and not self.isDatFile:
            return (m.group(1) + ' ',  m.group(2), '')

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

        # signum (unary - or +)
        m = self.p_sign.match(part)
        if m:
            return (m.group(1), m.group(2), m.group(3))

        # colon
        m = self.p_arg_colon.match(part)
        if m:
            return (m.group(1), ' ' + m.group(2), m.group(3))

        # ==, >=, <=, <>, etc
        m = self.p_op.match(part)
        if m and not self.isDatFile:
            return (m.group(1) + ' ', m.group(2), ' ' + m.group(3))

        # single operator (e.g. /, *, etc.)
        m = self.p_2op.match(part)
        if m and not self.isDatFile:
            return (m.group(1), m.group(2), m.group(3))        

        # single operator (e.g. +, -, etc.)
        m = self.p_3op.match(part)
        if m and not self.isDatFile:
            return (m.group(1) + ' ', m.group(2), ' ' + m.group(3))        

        # single operator (AND OR XOR B_)
        m = self.p_4op.match(part)
        if m and not self.isDatFile:
            return (m.group(1) + ' ', m.group(2), ' ' + m.group(3))   

        # function call
        m = self.p_func.match(part)
        if m:
            return (m.group(1), ' ' + m.group(2), m.group(3))
        m = self.p_func_2.match(part)
        if m:
            return (m.group(1), m.group(2), m.group(3))
        m = self.p_func_3.match(part)
        if m:
            return (m.group(1), '', m.group(3))
        m = self.p_func_4.match(part)
        if m:
            return (m.group(1), m.group(2), m.group(4))

        # comma/semicolon
        m = self.p_comma.match(part)
        if m and not self.isDatFile:
            return (m.group(1), m.group(2), ' ' + m.group(3))

        # multiple whitespace
        m = self.p_multiws.match(part)
        if m:
            return (m.group(1), ' ', m.group(3))

        return 0
        
    # recursively format string
    def format(self, part):
        m = self.extract(part)
        if m:
            return self.format(m[0]) + m[1] + self.format(m[2])
        return part

    # compute indentation
    def indent(self, add=0):
        return (self.ilvl+add)*self.indentWidth*' '

    # take care of indentation and call format(line)
    def formatLine(self, line):

        # determine if header
        if re.match(self.header, line):
            return (0, line)

        # find comments
        if re.match(self.linecomment, line):
            return (0, self.indent() + line.strip())

        # find control structures
        m = re.match(self.ctrl_1line, line)
        if m:
            return (0, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip() + ' ' + m.group(4) + ' ' + self.format(m.group(6)).strip())

        m = re.match(self.fcnstart, line)
        if m:
            if self.firstDef and not self.indentAfterMainFunction:
                self.firstDef = False
                return (0, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip())
            elif self.indentAfterFunction:
                self.step.append(1)
                return (1, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip())
            else:
                return (0, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip())

        m = re.match(self.fcnend, line)
        if m:
            if self.firstEnddef and not self.indentAfterMainFunction:
                self.firstEnddef = False
                return (0, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip())            
            elif self.indentAfterFunction:
                if len(self.step) > 0:
                    _step = self.step.pop()
                else:
                    print('There are more end-statements than blocks!', file=sys.stderr)
                    _step = 0
                return (-_step, self.indent(-_step) + m.group(2) + ' ' + self.format(m.group(3)).strip())
            else:
                return (0, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip())

        m = re.match(self.ctrlstart_for, line)
        if m:
            self.step.append(1)
            return (1, self.indent() + m.group(2) + ' ' + m.group(3).strip().replace(" ", "") + ' ' + self.format(m.group(4)).strip() + ' ' +  self.format(m.group(5)).strip())

        m = re.match(self.ctrlstart_then, line)
        if m:
            self.step.append(1)
            return (1, self.indent() + m.group(2) + ' ' + self.format(m.group(3)).strip() + ' ' + self.format(m.group(4)).strip() + ' ' +  self.format(m.group(5)).strip())

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
            return (-_step, self.indent(-_step) + m.group(2) + ' ' + self.format(m.group(4)).strip())

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
                rlines = f.readlines()[self.startLine-1:self.endLine]
        else:
            with open(self.filename, 'r', encoding='UTF-8') as f:
                rlines = f.readlines()[self.startLine-1:self.endLine]

        # take care of empty input
        if not rlines:
            rlines = ['']

        # get initial indent lvl
        p = r'(\s*)(.*)'
        m = re.match(p, rlines[0])
        if m:
            self.ilvl = len(m.group(1))//self.indentWidth
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
            if m:
                isFcnstart = True
            else:
                isFcnstart = False

            m = re.match(self.fcnend, line)
            if m:
                isFcnend = True
            else:
                isFcnend = False

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
            if m:
                lastLineIsComment = True
            else:
                lastLineIsComment = False

        # remove last line if blank
        while wlines and not wlines[-1]:
            wlines.pop()

        # take care of empty output
        if not wlines:
            wlines = ['']

        # write output
        for line in wlines:
            print(line)
